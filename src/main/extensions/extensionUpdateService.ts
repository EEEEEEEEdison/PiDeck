import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, PiCliUpdateResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import type { PiLocator } from "../pi/PiLocator";
import { PiProcess } from "../pi/PiProcess";
import { resolvePiSelfUpdateChannel } from "../pi/piSelfUpdateChannel";
import { compareVersions } from "../utils/versionCompare";
import { toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import { parsePiVersion } from "./extensionVersionGate";
import { PI_PACKAGE_NAME, type ExtensionCopy, type PiCliRunner } from "./piCliRunner";

/** pi 0.70.3 introduced self-update and the packages-only --extensions flag. */
const MIN_PI_VERSION_FOR_SELF_UPDATE = "0.70.3";

/** Numbered prereleases at the introduction boundary must not enable a not-yet-stable CLI API. */
function supportsPiSelfUpdate(version: string | undefined): boolean {
	const normalized = parsePiVersion(version);
	if (!normalized) return false;
	const [core] = normalized.split("-");
	const comparison = compareVersions(core ?? "", MIN_PI_VERSION_FOR_SELF_UPDATE);
	return comparison > 0 || (comparison === 0 && !normalized.includes("-"));
}

/**
 * 更新编排层需要的命令缝与上下文。
 * 命令一律走宿主注入的闭包：测试对 `manager.runPi` / `manager.fetchPiLatestVersion` 的打桩要继续生效，
 * 不能绕过 ExtensionManager 直接调 PiCliRunner。
 */
export type ExtensionUpdateHost = {
	locator: PiLocator;
	getSettings: () => AppSettings;
	getHomeDir: () => string;
	getWslEnvironment: () => WslEnvironment | null;
	translate: ExtensionCopy;
	/** 更新完成后清扩展列表缓存（列表由 ExtensionManager 持有，这里只发通知）。 */
	invalidateListCache: () => void;
	/** 自更新成功后丢弃 pi 版本探测缓存（失败也可能改动了文件，同样要丢）。 */
	resetVersionCache: () => void;
	runPi: PiCliRunner["runPi"];
	runPackageInstall: PiCliRunner["runPackageInstall"];
	runBunGlobalUpdate: PiCliRunner["runBunGlobalUpdate"];
	runNpmPrefixUpdate: PiCliRunner["runNpmPrefixUpdate"];
	npmViewVersion: PiCliRunner["npmViewVersion"];
	fetchPiLatestVersion: PiCliRunner["fetchPiLatestVersion"];
	sanitizeCommandOutput: PiCliRunner["sanitizeCommandOutput"];
};

/**
 * pi 自身与扩展的更新检查/执行编排（从 ExtensionManager 迁出；架构红线：单文件 ≤600 行）。
 * 职责边界：命令执行在 piCliRunner.ts，列表/开关/安装卸载仍在 ExtensionManager，
 * 本类只做「何时查、查谁、结果如何汇总」的编排。
 */
export class ExtensionUpdateService {
	constructor(private readonly host: ExtensionUpdateHost) {}

	async checkPiUpdate(): Promise<PiUpdateCheckResult> {
		return this.checkPiUpdateFor({ ...this.host.getSettings() });
	}

	/** Pin the installation settings throughout a check/update, even if the user switches runtimes. */
	async checkPiUpdateFor(settings: AppSettings): Promise<PiUpdateCheckResult> {
		try {
			const status = await this.host.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
			if (!status.installed) return { hasUpdate: false, error: this.host.translate("mainExtension.piNotInstalled") };
			// 与 `pi update --self` 使用同一个 pi.dev 版本接口，避免 npm latest 与 Pi 官方
			// 发布门槛短暂不同步时，PiDeck 显示的版本和 CLI 提示不一致。
			const release = await this.host.fetchPiLatestVersion(status.version ?? "0.0.0");
			return {
				currentVersion: status.version,
				latestVersion: release.version,
				hasUpdate: compareVersions(release.version, status.version ?? "0.0.0") > 0,
				// command / packageName 供 updatePi 的通道分派与包名 spec 使用。
				command: status.command,
				packageName: release.packageName,
			};
		} catch (error) {
			const detail = this.host.sanitizeCommandOutput(error instanceof Error ? error.message : String(error));
			void getAppLogger()?.error("extensions", "Pi update check failed", { error: detail });
			return { hasUpdate: false, error: `${this.host.translate("mainExtension.updateCheckFailed")}\n${detail}` };
		}
	}

	/** Self-update only the selected pi installation, and verify it instead of trusting exit status. */
	async updatePi(): Promise<PiCliUpdateResult> {
		const settings = { ...this.host.getSettings() };
		const check = await this.checkPiUpdateFor(settings);
		if (check.error) throw new Error(check.error);
		if (!check.hasUpdate) {
			return {
				command: "pi update --self",
				output:
					check.error ??
					this.host.translate("mainExtension.noUpdate", {
						current: check.currentVersion ?? "unknown",
						latest: check.latestVersion ?? "unknown",
					}),
				updated: false,
			};
		}
		// Older versions have no self-update API: do not guess npm/pnpm/standalone ownership.
		if (!supportsPiSelfUpdate(check.currentVersion)) {
			throw new Error(this.host.translate("mainExtension.piSelfUpdateUnsupported", { version: check.currentVersion || "?", minimum: MIN_PI_VERSION_FOR_SELF_UPDATE }));
		}
		// 通道分派（bun 全局 / 旧引导前缀 → PiDeck 代跑包管理器；其余 → pi 自身）。
		// 判定依赖 check 返回的 command（选中的 pi 可执行路径形状），见 piSelfUpdateChannel。
		const channel = resolvePiSelfUpdateChannel(check.command ?? "");
		const channelLabel = channel.kind === "bun-global" ? `bun install -g ${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion}` : channel.kind === "portable-prefix" ? `npm install -g ${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion} --prefix <pi-runtime>` : "pi update --self";
		let output: string;
		try {
			if (channel.kind === "bun-global") {
				output = await this.host.runBunGlobalUpdate(channel.bunCommand, check.latestVersion ?? "", check.packageName);
			} else if (channel.kind === "portable-prefix") {
				output = await this.host.runNpmPrefixUpdate(channel.prefixDir, check.latestVersion ?? "", check.packageName);
			} else {
				output = await this.host.runPi(["update", "--self"], 120_000, { offline: false, settings, version: check.currentVersion });
			}
		} finally {
			// A failed updater may still have changed files; never reuse a pre-update version probe.
			this.host.resetVersionCache();
			PiProcess.invalidateVersionCache();
		}
		const status = await this.host.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (!status.installed || !status.version || compareVersions(status.version, check.latestVersion ?? "0.0.0") < 0) {
			throw new Error(`${this.host.translate("mainExtension.piUpdateNotApplied", { current: status.version || "?", latest: check.latestVersion || "?" })}\n${this.host.sanitizeCommandOutput(output)}`);
		}
		return this.toUpdateResult(channelLabel, output, true);
	}

	/** Before self-update existed, bare `pi update` updated packages only. Keep that safe compatibility. */
	async updateExtensions(): Promise<PiCliUpdateResult> {
		const settings = { ...this.host.getSettings() };
		const status = await this.host.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (!status.installed) throw new Error(this.host.translate("mainExtension.piNotInstalled"));
		if (!parsePiVersion(status.version)) throw new Error(this.host.translate("mainExtension.piVersionUnknown"));
		const args = supportsPiSelfUpdate(status.version) ? ["update", "--extensions"] : ["update"];
		try {
			const output = await this.host.runPi(args, 120_000, { offline: false, settings, version: status.version });
			return this.toUpdateResult(`pi ${args.join(" ")}`, output, true);
		} finally {
			// A multi-package failure can still update earlier packages; refresh their displayed versions.
			this.host.invalidateListCache();
		}
	}

	/** 更新单个扩展：`pi update <source>`，source 与 list 输出一致（如 npm:context-mode）。 */
	async updateExtension(source: string): Promise<PiCliUpdateResult> {
		try {
			const output = await this.host.runPi(["update", source], 120_000, { offline: false });
			return this.toUpdateResult(`pi update ${source}`, output, true);
		} finally {
			this.host.invalidateListCache();
		}
	}

	async enrichExtensionVersion(extension: PiExtensionSummary, resolveLatestVersion: (packageName: string) => Promise<string | null>): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) return extension;
		const packageName = extension.source.replace(/^npm:/i, "");
		try {
			const [currentVersion, latestVersion] = await Promise.all([this.readInstalledVersion(extension.path), resolveLatestVersion(packageName)]);
			return {
				...extension,
				currentVersion,
				// 快路与回退都以 null 表示「没查到」，投影到 PiExtensionSummary 的 undefined 语义
				latestVersion: latestVersion ?? undefined,
				hasUpdate: Boolean(currentVersion && latestVersion && compareVersions(latestVersion, currentVersion) > 0),
			};
		} catch (error) {
			console.error("[ExtensionManager] Extension version check failed", error);
			return { ...extension, updateError: this.host.translate("mainExtension.versionCheckFailed") };
		}
	}

	async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		// 先落成局部变量再窄化：wslEnvironment 现在是宿主回调，TS 不会跨两次调用做窄化。
		const wsl = this.host.getWslEnvironment();
		const hostPath = wsl ? toWindowsHostPath(path, wsl) : path;
		const raw = await readFile(join(hostPath, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
	}

	toUpdateResult(command: string, output: string, updated: boolean): PiCliUpdateResult {
		return { command: this.host.sanitizeCommandOutput(command), output: this.host.sanitizeCommandOutput(output), updated };
	}
}
