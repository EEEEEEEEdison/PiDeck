import { execFile } from "node:child_process";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AppSettings } from "../../shared/types";
import { redactForReport, truncateText } from "../health/redact";
import { getAppLogger } from "../logging/sharedLogger";
import type { PiLocator } from "../pi/PiLocator";
import { readConfiguredNpmCommand } from "../resourceWhitelist";
import { toWslLinuxPath, type WslEnvironment } from "../wsl/WslPaths";
import { parsePiVersion, piVersionAtLeast } from "./extensionVersionGate";

/** pi 的 npm 包名。pi.dev 版本接口在包改名迁移期可返回不同 packageName，见 fetchPiLatestVersion。 */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const PI_LATEST_VERSION_TIMEOUT_MS = 10_000;

type SettingsProvider = () => AppSettings;
/** 主进程文案取词函数（ExtensionManager 与更新编排层共用）。 */
export type ExtensionCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/** runPi 调用选项（原 ExtensionManager 的内联类型，迁出后导出以保持调用点签名不变）。 */
export type PiRunOptions = { offline?: boolean; cwd?: string; projectInstall?: boolean; settings?: AppSettings; version?: string };

/**
 * pi CLI 与 npm 子进程收口：扩展域的版本探测、`pi <args>` 代跑、npm 版本查询与 registry 基址解析。
 *
 * 迁出动机（架构红线）：ExtensionManager 曾内联这些「进程调用」细节，单文件超 600 行。
 * 本类只负责「起进程 + 解析输出 + 版本缓存」，安装/卸载/更新编排仍留在 ExtensionManager。
 * 依赖全部经构造参数注入，home/WSL 环境用 getter 惰性读取，保证切换 WSL home 后行为与迁出前一致。
 */
export class PiCliRunner {
	/** 缓存的 pi 版本号，用于条件性传递 --no-approve。 */
	private piVersion: string | null = null;
	private piVersionPromise: Promise<string | null> | null = null;

	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
		private readonly getHomeDir: () => string,
		private readonly getWslEnvironment: () => WslEnvironment | null,
		private readonly translate: ExtensionCopy = () => "Extension operation failed.",
	) {}

	/** 自更新后清空版本缓存（原先由 ExtensionManager.updatePi 的 finally 直接置 null）。 */
	resetVersionCache() {
		this.piVersion = null;
		this.piVersionPromise = null;
	}

	private get homeDir(): string {
		return this.getHomeDir();
	}

	private get wslEnvironment(): WslEnvironment | null {
		return this.getWslEnvironment();
	}

	/** 代跑包管理器安装（bun/npm 全局自更新）：复用 locator 的 PATH 补齐与 shell 决策（与 npmViewVersion 同模式）。 */
	runPackageInstall(commandPath: string, args: string[], timeoutMs: number): Promise<string> {
		const invocation = this.locator.createInvocation(commandPath, args);
		return new Promise((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: timeoutMs,
					maxBuffer: 4 * 1024 * 1024,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(new Error(this.sanitizeCommandOutput(`${stdout}\n${stderr}`) || String(error)));
						return;
					}
					resolve(`${stdout}\n${stderr}`.trim());
				},
			);
		});
	}

	/** bun 全局安装代跑：参数对齐 pi 自身 bun 分支（`bun install -g <pkg>@<ver>`）。 */
	runBunGlobalUpdate(bunCommand: string, version: string, packageName?: string): Promise<string> {
		return this.runPackageInstall(bunCommand, ["install", "-g", `${packageName ?? PI_PACKAGE_NAME}@${version}`], 180_000);
	}

	/** 旧引导前缀代跑：npm 落回用户全局目录时前缀副本永远停旧，必须显式 --prefix。 */
	async runNpmPrefixUpdate(prefixDir: string, version: string, packageName?: string): Promise<string> {
		// 复用 pi settings.json 的 npmCommand（与包资源安装同源）：裸 npm 在 GUI PATH 里找不到时，
		// 用户配置的包装命令在这里同样生效（#318/#263）。
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		return this.runPackageInstall(configured[0], [...configured.slice(1), "install", "-g", `${packageName ?? PI_PACKAGE_NAME}@${version}`, "--prefix", prefixDir], 300_000);
	}

	async fetchPiLatestVersion(currentVersion: string, timeoutMs: number = PI_LATEST_VERSION_TIMEOUT_MS): Promise<{ version: string; packageName?: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// 必须走 Electron net.fetch（Chromium 网络栈）：系统代理与 PiDeck 桌面代理
			//（defaultSession.setProxy）才会生效。裸全局 fetch 是 undici 实现，不读任何
			// 代理配置，代理网络下直连 pi.dev 十秒必超时（v0.7.9 起的回归，报错只有
			// 含糊的 AbortError "This operation was aborted"）。动态 import 保持可单测
			//（沙箱注入 electron 桩），与 tokendanceCatalog 等主进程联网点同模式。
			const { net } = await import("electron");
			const response = await net.fetch(PI_LATEST_VERSION_URL, {
				headers: { accept: "application/json", "user-agent": `pi-deck/${currentVersion}` },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`pi version check returned HTTP ${response.status}`);
			const payload: unknown = await response.json();
			if (typeof payload !== "object" || payload === null || !("version" in payload) || typeof payload.version !== "string" || !payload.version.trim()) {
				throw new Error("pi version check returned an invalid version");
			}
			// packageName 可选：pi.dev 在包改名迁移期返回与默认包名不同的目标（pi 自身的
			// getSelfUpdatePlan 同样处理），代跑更新时用它拼 <pkg>@<ver>，否则用默认包名。
			const rawPackageName = "packageName" in payload && typeof payload.packageName === "string" ? payload.packageName.trim() : "";
			return { version: payload.version.trim(), ...(rawPackageName ? { packageName: rawPackageName } : {}) };
		} catch (error) {
			// abort() 不带 reason 时上游只会给 "This operation was aborted"，用户无从判断；
			// 命中本方法自己的超时信号时统一转成明确超时文案，真实网络错误原样透传。
			if (controller.signal.aborted) {
				throw new Error(`pi.dev version check timed out after ${Math.round(timeoutMs / 1000)}s (network unreachable or proxy required)`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	npmViewVersion(packageName: string) {
		// 复用 pi settings.json 的 npmCommand（与包资源安装同源）：裸 npm 在 GUI PATH 里找不到时
		// （fnm/nvm XDG 布局等），用户配置的包装命令在这里同样生效（#318/#263 遗留）。
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		const invocation = this.locator.createInvocation(configured[0], [...configured.slice(1), "view", packageName, "version"]);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 30_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						reject(new Error((stderr || error.message).trim()));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
	}

	/**
	 * 解析 npm registry 基址（`npm config get registry`）：与 npm view 走同一 npm 上下文，
	 * 自动尊重 user/project npmrc 的镜像与 scope 配置。子进程失败、超时或输出不是
	 * http(s) 地址时返回 null，版本查询整轮回退 npm view 子进程（现状行为）。
	 */
	resolveNpmRegistryBase(): Promise<string | null> {
		const configured = readConfiguredNpmCommand(join(this.homeDir, ".pi", "agent", "settings.json"));
		const invocation = this.locator.createInvocation(configured[0], [...configured.slice(1), "config", "get", "registry"]);
		return new Promise<string | null>((resolve) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 10_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout) => {
					const value = (error ? "" : stdout).trim();
					resolve(/^https?:\/\//i.test(value) ? value : null);
				},
			);
		});
	}

	/** CLI output can include registry credentials or personal paths; redact before logging/displaying it. */
	sanitizeCommandOutput(value: string): string {
		return truncateText(redactForReport(value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim(), this.homeDir), 4_000);
	}

	/**
	 * --no-approve 标志在 pi 0.79.0 引入。检测本地安装的 pi 版本是否支持。
	 */
	private async noApproveSupported(): Promise<boolean> {
		const version = await this.getPiVersion();
		// 完整 semver 比较：0.79+ 与 1.x+ 均支持；版本未知时不支持。
		return piVersionAtLeast(version, "0.79.0");
	}

	async getPiVersion(): Promise<string | null> {
		if (this.piVersion) return this.piVersion;
		if (this.piVersionPromise) return this.piVersionPromise;
		this.piVersionPromise = this.detectPiVersion();
		return this.piVersionPromise;
	}

	/**
	 * 启动空闲预热：提前跑一次 pi 版本探测并写入 piVersion 缓存，让首次
	 * extensions:list 的 --no-approve 判定不再同步等待 `pi --version` 子进程。
	 *
	 * 尽力而为语义（预热硬约束）：已有缓存则直接返回、不重复探测；探测失败只记日志，
	 * 并把缓存还原成未探测状态——不把 null 固化，否则一次失败的预热会让后续真实调用
	 * 永远拿不到版本，--no-approve 判定被永久降级（预热失败不得影响任何主流程）。
	 */
	async warmPiVersionProbe(): Promise<void> {
		if (this.piVersion) return;
		// 只回滚自己发起的探测：蹭已在飞的探测时失败结果归真实调用方语义，不干预。
		const startedProbe = this.piVersionPromise === null;
		// getPiVersion 函数体内没有 await，调用返回时登记已同步完成；async 包装器不是登记物，
		// 紧邻一次读取拿到的才是本次自发探测写进 this.piVersionPromise 的那个 promise 身份。
		const probePromise = this.getPiVersion();
		const registeredProbe = this.piVersionPromise;
		try {
			const version = await probePromise;
			// 交错窗口内末写者胜出：applyUpdate 的 finally 先清空缓存、新调用方随后登记新探测时，
			// 抹掉 this.piVersionPromise 会让后续真实调用白跑一次 `pi --version` 子进程；
			// 只有登记者仍是本次自发探测才还原，否则保留新调用方的登记。
			if (startedProbe && version === null && this.piVersionPromise === registeredProbe) this.piVersionPromise = null;
		} catch (error) {
			if (startedProbe && this.piVersionPromise === registeredProbe) this.piVersionPromise = null;
			void getAppLogger()?.warn("extensions", "pi version prewarm failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async detectPiVersion(): Promise<string | null> {
		try {
			const settings = this.getSettings();
			const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
			if (status.installed && status.version) {
				this.piVersion = status.version;
				return status.version;
			}
		} catch {
			// 版本检测失败时静默处理，后续调用方会 fallback 为不支持 --no-approve
		}
		return null;
	}

	async runPi(args: string[], timeout: number, options: PiRunOptions = {}): Promise<string> {
		// 项目安装必须让 pi 读取已通过 PiDeck trust 校验的项目资源；--no-approve 会绕过该路径。
		const finalArgs = [...args];
		const noApproveSupported = options.version === undefined ? await this.noApproveSupported() : piVersionAtLeast(options.version, "0.79.0");
		if (!options.projectInstall && noApproveSupported) {
			finalArgs.push("--no-approve");
		}
		const settings = options.settings ?? this.getSettings();
		// 设置页装扩展可以等 WSL which；不能在 resolveCommand 里同步卡住主进程。
		if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
			await this.locator.warmWslCommand(settings.wslDistro, settings.wslUser);
		}
		const runtimeCwd = options.cwd && this.wslEnvironment ? toWslLinuxPath(options.cwd, this.wslEnvironment) : options.cwd;
		const command = this.locator.resolveCommand(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		const invocation = this.locator.createInvocation(command, finalArgs, {
			wslCwd: this.wslEnvironment && runtimeCwd ? runtimeCwd : undefined,
		});
		const env = this.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl);
		// list/remove 默认走离线模式避免配置页被网络拖慢；store install 与 update 显式允许联网，
		// 否则 pi 只会返回简化的结果，无法真正完成包安装/更新。
		if (options.offline !== false) env.PI_OFFLINE = "1";
		else delete env.PI_OFFLINE;
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env,
					...(invocation.wsl ? {} : { cwd: runtimeCwd }),
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const detail = this.sanitizeCommandOutput([stderr, stdout, error.message].filter(Boolean).join("\n"));
						void getAppLogger()?.error("extensions", "pi command failed", {
							args: finalArgs.map((arg) => this.sanitizeCommandOutput(arg)),
							error: detail,
							code: error.code,
							signal: error.signal,
						});
						const reason = this.translate(error.killed ? "mainExtension.commandTimedOut" : "mainExtension.commandFailed", { seconds: timeout / 1_000 });
						reject(new Error(`${reason}\n${detail}`));
						return;
					}
					// Update tools often write their actionable package-manager notices to stderr.
					resolve(args[0] === "update" && stderr.trim() ? `${stdout}\n${stderr}` : stdout);
				},
			);
		});
	}
}
