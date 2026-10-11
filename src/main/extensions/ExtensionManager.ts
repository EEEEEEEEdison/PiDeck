import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import type { AppSettings, DisabledExtensionEntry, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { INTERNAL_BUILT_IN_EXTENSIONS, isBuiltInExtensionName, isDefaultDisabledBuiltInExtension, type BuiltInExtensionPathRoots } from "./builtInExtensions";
// pi CLI / npm 子进程收口已迁出（架构红线：单文件 ≤600 行）：版本探测、runPi、registry 版本查询见 piCliRunner.ts。
import { MIN_PI_VERSION_FOR_EXTENSION_WHITELIST, piVersionAtLeast } from "./extensionVersionGate";
import { PI_PACKAGE_NAME, PiCliRunner, type PiRunOptions } from "./piCliRunner";
// 扫描/解析叶子逻辑已迁出：目录扫描、pi list 解析、本地文件判定见 extensionScan.ts。
import { isLocalFileExtension, parseListOutput, scanLocalExtensions } from "./extensionScan";
// 更新编排已迁出（pi 自更新 / 扩展更新检查）：实现见 extensionUpdateService.ts。
import { ExtensionUpdateService } from "./extensionUpdateService";
// 列表组装 / 缓存 / enabled 投影与内置冲突自动禁用已迁出：实现见 extensionListCache.ts。
import { ExtensionListCache, type ExtensionNativeState } from "./extensionListCache";

export { BUILT_IN_EXTENSIONS } from "./builtInExtensions";

/**
 * pi list 对「过滤式安装」包的 source 后缀（定义与解析实现见 extensionScan.ts，此处转出以保留既有导入点）。
 */
export { FILTERED_SUFFIX } from "./extensionScan";

// 类型与冲突规则随实现迁到 extensionListCache.ts，此处转出以保留既有导入点。
export type { ExtensionNativeState } from "./extensionListCache";
export { BUILT_IN_CONFLICT_KEYWORDS, extensionNameMatches } from "./extensionListCache";

type SettingsProvider = () => AppSettings;
type ExtensionCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * 自动检测 pi 版本，条件性添加 --no-approve（仅 pi >= 0.79.0 支持），
 * 兼容老版本避免 unknown option 错误。
 */
export class ExtensionManager {
	private wslEnvironment: WslEnvironment | null = null;

	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
		/** 获取 PiDeck 桌面设置（含 removedBuiltInExtensions） */
		private readonly getPiDeckSettings: () => AppSettings = getSettings,
		/** 保存 PiDeck 桌面设置的部分更新 */
		private readonly patchPiDeckSettings: (patch: Partial<AppSettings>) => Promise<AppSettings> = async () => getSettings(),
		private readonly translate: ExtensionCopy = () => "Extension operation failed.",
		/** 内置扩展磁盘根：提供后可为内置扩展补齐真实路径，使「打开目录」可用。 */
		private readonly builtInRoots: BuiltInExtensionPathRoots | undefined = undefined,
	) {
		this.piRunner = new PiCliRunner(
			locator,
			getSettings,
			() => this.homeDir,
			() => this.wslEnvironment,
			translate,
		);
		// 宿主回调一律用箭头做晚绑定：外部对 manager.runPi / manager.fetchPiLatestVersion 的打桩
		// 必须继续生效，同时编排层不直接持有 PiCliRunner。
		this.updateService = new ExtensionUpdateService({
			locator,
			getSettings,
			getHomeDir: () => this.homeDir,
			getWslEnvironment: () => this.wslEnvironment,
			translate,
			invalidateListCache: () => this.invalidateListCache(),
			resetVersionCache: () => this.piRunner.resetVersionCache(),
			runPi: (args, timeoutMs, options) => this.runPi(args, timeoutMs, options),
			runPackageInstall: (commandPath, args, timeoutMs) => this.runPackageInstall(commandPath, args, timeoutMs),
			runBunGlobalUpdate: (bunCommand, version, packageName) => this.runBunGlobalUpdate(bunCommand, version, packageName),
			runNpmPrefixUpdate: (prefixDir, version, packageName) => this.runNpmPrefixUpdate(prefixDir, version, packageName),
			npmViewVersion: (packageName) => this.npmViewVersion(packageName),
			fetchPiLatestVersion: (currentVersion, timeoutMs) => this.fetchPiLatestVersion(currentVersion, timeoutMs),
			sanitizeCommandOutput: (value) => this.sanitizeCommandOutput(value),
		});
		// 列表缓存/投影的命令缝同样走宿主薄包装：manager.loadList、manager.runPi 的打桩必须继续生效。
		this.listCacheStore = new ExtensionListCache({
			getPiDeckSettings: () => this.getPiDeckSettings(),
			getBuiltInRoots: () => this.builtInRoots,
			getNativeEnabledReader: () => this.nativeEnabledReader,
			runPi: (args, timeoutMs, options) => this.runPi(args, timeoutMs, options),
			scanLocalExtensions: () => this.scanLocalExtensions(),
			parseListOutput: (raw) => this.parseListOutput(raw),
			enrichExtensionVersion: (extension, resolveLatestVersion) => this.enrichExtensionVersion(extension, resolveLatestVersion),
			resolveNpmRegistryBase: () => this.resolveNpmRegistryBase(),
			npmViewVersion: (packageName) => this.npmViewVersion(packageName),
			removeBuiltInFile: (source) => this.removeBuiltInFile(source),
			saveRemovedBuiltIn: (removedList) => this.saveRemovedBuiltIn(removedList),
			loadList: (includeVersionInfo) => this.loadList(includeVersionInfo),
		});
	}

	/** 将扩展文件边界切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		// 切换 WSL/本地 home 后旧缓存失效。
		this.invalidateListCache();
	}

	private get homeDir(): string {
		return this.wslEnvironment?.windowsHome ?? homedir();
	}

	/** 当前生效的用户 home（供插件开发等需要与扩展目录同源的调用方读取）。 */
	get userHomeDir(): string {
		return this.homeDir;
	}

	/** pi/npm 子进程收口：版本探测、runPi、registry 版本查询（实现见 piCliRunner.ts）。 */
	private readonly piRunner: PiCliRunner;

	/** pi 自更新 / 扩展更新编排（实现见 extensionUpdateService.ts）。 */
	private readonly updateService: ExtensionUpdateService;

	/** 列表组装 + 缓存 + enabled 投影（实现见 extensionListCache.ts）。 */
	private readonly listCacheStore: ExtensionListCache;

	/** 删除本地扩展文件/目录：只允许 extensions 目录下的单层 basename，防止路径穿越。 */
	private async removeLocalExtension(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		// source 必须等于 basename（如 orca-agent-status.ts），拒绝 ../ 或绝对路径穿越。
		if (!name || name !== trimmed || name === "." || name === "..") {
			throw new Error(this.translate("mainExtension.invalidPath"));
		}
		const targetPath = join(extensionsDir, name);
		// 本地扩展是用户安装的代码：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await trashPath(targetPath, { source: "extension:uninstall" });
	}

	/**
	 * 卸载后清理禁用记录：1) 旧路径遗留的 pi settings.json disabledExtensions（兼容手动写入/旧版，
	 * 按 source 匹配）；2) PiDeck settings 的 scoped 条目——只清与本次卸载相同作用域的条目，
	 * 避免「卸载项目版但保留用户版禁用状态」被误清。
	 */
	private async clearDisabledEntry(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		try {
			const settingsPath = join(this.homeDir, ".pi", "agent", "settings.json");
			const raw = await readFile(settingsPath, "utf8");
			const settings = JSON.parse(raw) as { disabledExtensions?: string[] };
			const disabled = settings.disabledExtensions ?? [];
			if (disabled.includes(source)) {
				settings.disabledExtensions = disabled.filter((item) => item !== source);
				await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
			}
		} catch {
			// settings 不存在或解析失败时忽略；卸载主流程已成功
		}
		try {
			const current = this.getPiDeckSettings().disabledExtensions ?? [];
			const next = current.filter((entry) => !(entry.scope === scope && entry.source === source));
			if (next.length !== current.length) {
				await this.patchPiDeckSettings({ disabledExtensions: next });
			}
		} catch {
			// PiDeck 设置写入失败不阻塞卸载主流程
		}
	}

	/**
	 * 删除用户扩展目录中的内置扩展文件。
	 * 只允许 pi-deck-* 单层 basename，防止路径穿越。
	 * force: 文件本就不存在时静默成功（幂等，适合启动残留清理）。
	 */
	async removeBuiltInFile(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		if (!name || name !== trimmed || !isBuiltInExtensionName(name)) {
			throw new Error("非法内置扩展路径");
		}
		// 早返回：loadList 每次都会对 removedBuiltInExtensions 逐项调用本方法清理残留，
		// 绝大多数条目早已不存在；先 existsSync 判定可免掉无效的 rm 系统调用（force 语义保留给真实存在）。
		const target = join(extensionsDir, name);
		if (!existsSync(target)) {
			return;
		}
		await rm(target, { force: true });
		// 启动残留清理的硬删（非用户主动删除，仅限 pi-deck-* 内置白名单）：记日志便于审计。
		getAppLogger()?.info("extension", "Built-in extension file removed", { name, path: join(extensionsDir, name) });
	}

	private async saveRemovedBuiltIn(removedList: string[]): Promise<void> {
		await this.patchPiDeckSettings({ removedBuiltInExtensions: removedList });
	}

	/**
	 * 禁用内置扩展：记入 removedBuiltInExtensions（RPC 启动时跳过 -e），
	 * 并清理用户扩展目录中可能残留的历史部署副本。
	 */
	async disableBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		// 白名单成员才可操作：pi-deck-* 前缀不足以证明内置身份（demo 等用户文件同前缀）。
		if (!isBuiltInExtensionName(normalized)) {
			throw new Error("只能操作内置扩展");
		}
		if ((INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(normalized)) {
			throw new Error("内部内置扩展不可禁用");
		}
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		if (!current.includes(normalized)) {
			await this.saveRemovedBuiltIn([...current, normalized]);
		}
		// 幂等清理旧部署；新路径不再依赖用户目录文件。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	async removeBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		// 白名单判定（与 disableBuiltIn 一致）：防 IPC 直接传非内置名（如 demo）走内置删除路径。
		if (!isBuiltInExtensionName(normalized)) {
			throw new Error("只能操作内置扩展");
		}
		await this.disableBuiltIn(normalized);
	}

	/**
	 * 恢复内置扩展：仅从 removedBuiltInExtensions 移除标记。
	 * 下次 Agent 启动会重新通过 -e 从 app resources 加载，无需再写用户扩展目录。
	 */
	async restoreBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		const next = current.filter((s) => s !== normalized);
		if (next.length === current.length) return;
		await this.saveRemovedBuiltIn(next);
		// 若用户目录仍有旧副本，一并删掉，避免与 -e 双加载。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	/**
	 * 开关「默认关闭」（opt-in）的内置扩展：enabled=true 写入 enabledBuiltInExtensions，
	 * false 则移出；不碰 removedBuiltInExtensions（那是另一套「用户主动禁用默认启用扩展」机制）。
	 * 下次 Agent 启动时按 opt-in 列表决定是否随 -e 注入。
	 */
	async toggleBuiltIn(source: string, enabled: boolean): Promise<void> {
		const normalized = source.trim();
		if (!isDefaultDisabledBuiltInExtension(normalized)) {
			throw new Error("仅默认关闭的内置扩展支持此开关");
		}
		// 自愈：历史上被「移除」过（进了 removedBuiltInExtensions）的 opt-in 扩展，
		// 用户重新打开开关时同步清掉 removed 标记——否则开关 ON 但注入层仍被 removed 拦住。
		if (enabled) {
			const removed = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
			if (removed.includes(normalized)) {
				await this.saveRemovedBuiltIn(removed.filter((s) => s !== normalized));
			}
		}
		const current = this.getPiDeckSettings().enabledBuiltInExtensions ?? [];
		const next = enabled ? (current.includes(normalized) ? current : [...current, normalized]) : current.filter((s) => s !== normalized);
		if (next.length === current.length && next.every((s, i) => s === current[i])) return;
		await this.patchPiDeckSettings({ enabledBuiltInExtensions: next });
		this.invalidateListCache();
	}

	/** 卸载：user/unknown 走全局缓存；project 走 `pi remove -l`，projectRoot 由 IPC 层经信任校验解析后传入。 */
	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user", options: { projectRoot?: string } = {}): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.sourceRequired"));
		// 只挡白名单内置成员：pi-deck- 前缀不足以证明内置身份——插件开发 demo
		// （pi-deck-demo-plugin.ts）是普通本地扩展，卸载走删文件路径；真内置行的
		// 「卸载」由 removeBuiltIn（标记 removed + 删文件）承担，不能混用普通卸载。
		if (isBuiltInExtensionName(normalized)) {
			throw new Error(this.translate("mainExtension.builtInCannotUninstall"));
		}
		// 本地 .ts/目录扩展不在 pi package 列表里，pi remove 会报 No matching package；
		// 例如 orca-agent-status.ts 只能直接删文件。
		if (this.isLocalFileExtension(normalized)) {
			await this.removeLocalExtension(normalized);
		} else {
			// 项目层 remove 与 install 同一信任路径：带项目 cwd + projectInstall（不推 --no-approve）。
			// --no-approve 下 pi 视项目为不信任直接拒改本地 packages（"Project is not trusted"），且无 cwd 会删错目录。
			await this.runPi(["remove", normalized, ...(scope === "project" ? ["-l"] : [])], 30_000, options.projectRoot ? { cwd: options.projectRoot, projectInstall: true } : {});
		}
		await this.clearDisabledEntry(normalized, scope);
		// 列表已变，清缓存，避免 UI 继续读到旧安装态。
		this.invalidateListCache();
	}

	/** Install globally or in the selected pi 0.85 project scope. */
	async install(source: string, options: { projectRoot?: string } = {}): Promise<string> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.nameRequired"));
		const args = ["install", normalized, ...(options.projectRoot ? ["-l"] : [])];
		const result = await this.runPi(args, 120_000, {
			offline: false,
			cwd: options.projectRoot,
			projectInstall: Boolean(options.projectRoot),
		});
		this.invalidateListCache();
		return result;
	}

	/**
	 * 开关扩展：enabled=false 写入 PiDeck settings 的 disabledExtensions（scope+source），
	 * 启动 RPC 时由白名单模式生效；enabled=true 从列表移除。
	 * 不写 pi settings.json：pi 0.82.x 不支持 disabledExtensions，写了也不生效。
	 */
	/**
	 * 注入原生开关（A4）：装配后扩展到开关写 pi settings.json 的过滤规则
	 * （包安装 → 整包停用；本地文件扩展 → 顶层精确 `+path`/`-path`），
	 * 与 TUI 的 pi config 等价。未装配时退回旧禁用列表（渐进迁移，行为不突变）。
	 */
	configureNativeToggle(toggle: (input: { source: string; path?: string; scope: PiExtensionSummary["scope"]; projectId?: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>): void {
		this.nativeToggle = toggle;
	}

	/** 注入原生有效状态读取（迁移完成后禁用列表不再是真值来源）。 */
	configureNativeEnabledReader(reader: (extension: PiExtensionSummary) => ExtensionNativeState | undefined): void {
		this.nativeEnabledReader = reader;
	}

	private nativeToggle: ((input: { source: string; path?: string; scope: PiExtensionSummary["scope"]; projectId?: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>) | null = null;
	private nativeEnabledReader: ((extension: PiExtensionSummary) => ExtensionNativeState | undefined) | null = null;

	/**
	 * UI 开关统一入口（桌面 IPC 与 Web 工作区路由共用）：先按身份分流——内置扩展走 PiDeck 设置
	 * （`-e` 注入 / removedBuiltInExtensions），其余走 pi 原生过滤规则。
	 *
	 * 分流必须收口在这一层：Web 路由若各自调 setEnabled，内置扩展会被写成顶层 `+/-<source>` 垃圾规则
	 * （pi 匹配不上、界面却报成功）；Web 端扩展列表又刻意剥离了宿主机路径，本地文件扩展会写出一条
	 * pi 永远匹配不上的 `+/-<source>`。两者都在这里补齐。
	 */
	async toggleFromUi(source: string, enabled: boolean, scope: PiExtensionSummary["scope"] = "user", path?: string, projectId?: string): Promise<void> {
		const normalized = source.trim();
		// 白名单判定：pi-deck-* 前缀不足以证明内置身份（插件开发 demo 同前缀，是普通本地扩展）。
		if (isBuiltInExtensionName(normalized)) {
			if (isDefaultDisabledBuiltInExtension(normalized)) {
				// 默认关闭的内置扩展（GUI 桥/扩展点面板）：开关写 enabledBuiltInExtensions（opt-in）；
				// 注意不碰 removedBuiltInExtensions——那是「默认启用扩展的用户禁用」机制，语义互斥。
				await this.toggleBuiltIn(normalized, enabled);
			} else if (enabled) {
				await this.restoreBuiltIn(normalized);
			} else {
				await this.disableBuiltIn(normalized);
			}
			return;
		}
		// 本地文件扩展的原生规则按真实磁盘路径精确匹配（pi 按绝对路径 / baseDir 相对路径匹配），
		// 缺 path 时（Web 端列表不带路径）从列表缓存反查；包安装按 `npm:` 等 source 协议分流，path 会被忽略。
		const resolvedPath = path ?? (await this.resolveExtensionPath(normalized));
		await this.setEnabled(normalized, enabled, scope, resolvedPath, projectId);
	}

	/** 从扩展列表缓存按 source 反查真实路径；列表不可用或查不到时返回 undefined（由 setEnabled 按原样处理）。 */
	private async resolveExtensionPath(source: string): Promise<string | undefined> {
		try {
			const listed = await this.list();
			return listed.extensions.find((entry) => entry.source === source)?.path;
		} catch {
			return undefined;
		}
	}

	async setEnabled(source: string, enabled: boolean, scope: PiExtensionSummary["scope"] = "user", path?: string, projectId?: string): Promise<void> {
		// 原生配置优先：迁移完成后旧禁用列表已清空，开关直接写 pi 的过滤规则。
		if (this.nativeToggle) {
			const result = await this.nativeToggle({ source, path, scope, projectId, enabled });
			if (!result.ok) throw new Error(result.error ?? "Extension toggle failed.");
			// 不清列表缓存：开关只改 enabled，而 enabled 每次读取都由 applyEnabledProjection 重算
			// （原生规则 + PiDeck 禁用列表），结构信息（path/source/版本）不受影响。清缓存会让跟随
			// 开关的 UI 刷新白等一次 `pi list` 全量扫描（表现为开关行长时间 pending）。
			return;
		}
		// 旧兜底路径的版本门槛（原生开关已在上方优先处理）：过低版本的资源过滤语义不可考，
		// 直接拒绝禁用并提示；启用/移除禁用条目无风险，不做检查；版本未知（getPiVersion 为
		// null，如 pi 未安装/探测失败）时放行，避免拦截其他流程。
		if (!enabled) {
			const version = await this.getPiVersion();
			if (version !== null && !piVersionAtLeast(version, MIN_PI_VERSION_FOR_EXTENSION_WHITELIST)) {
				throw new Error(this.translate("mainExtension.piVersionTooOldForDisable", { version: version ?? "?" }));
			}
		}
		const current = this.getPiDeckSettings().disabledExtensions ?? [];
		const key = (entry: DisabledExtensionEntry) => `${entry.scope}:${entry.source}`;
		// 同 scope+source 只保留一条；不同 scope（user/project）相互独立，同名可在一处禁用、另一处启用。
		const next = current.filter((entry) => key(entry) !== `${scope}:${source.trim()}`);
		if (!enabled) {
			next.push({ scope, source: source.trim() });
		}
		await this.patchPiDeckSettings({ disabledExtensions: next });
		// 同上：结构未变，enabled 由投影重算，不清缓存（清缓存会让开关后的刷新付出一次全量扫描）。
	}

	// ── 迁出成员的同名薄包装：实现都在 piCliRunner.ts / extensionScan.ts，
	// 包一层是为了让本类内部调用点与既有测试注入面（manager.runPi / manager.fetchPiLatestVersion 等）保持不变。

	private runPi(args: string[], timeoutMs: number, options: PiRunOptions = {}): Promise<string> {
		return this.piRunner.runPi(args, timeoutMs, options);
	}

	private runPackageInstall(commandPath: string, args: string[], timeoutMs: number): Promise<string> {
		return this.piRunner.runPackageInstall(commandPath, args, timeoutMs);
	}

	private runBunGlobalUpdate(bunCommand: string, version: string, packageName?: string): Promise<string> {
		return this.piRunner.runBunGlobalUpdate(bunCommand, version, packageName);
	}

	private runNpmPrefixUpdate(prefixDir: string, version: string, packageName?: string): Promise<string> {
		return this.piRunner.runNpmPrefixUpdate(prefixDir, version, packageName);
	}

	private npmViewVersion(packageName: string) {
		return this.piRunner.npmViewVersion(packageName);
	}

	private resolveNpmRegistryBase(): Promise<string | null> {
		return this.piRunner.resolveNpmRegistryBase();
	}

	private fetchPiLatestVersion(currentVersion: string, timeoutMs?: number): Promise<{ version: string; packageName?: string }> {
		return this.piRunner.fetchPiLatestVersion(currentVersion, timeoutMs);
	}

	private getPiVersion(): Promise<string | null> {
		return this.piRunner.getPiVersion();
	}

	/** 启动预热：把 pi --version 探测挪到列表请求之前（避免首次进扩展页同步等子进程）。 */
	async warmPiVersionProbe(): Promise<void> {
		return this.piRunner.warmPiVersionProbe();
	}

	private sanitizeCommandOutput(value: string): string {
		return this.piRunner.sanitizeCommandOutput(value);
	}

	private parseListOutput(raw: string): PiExtensionSummary[] {
		return parseListOutput(raw);
	}

	/** 本地（~/.pi/agent/extensions）目录扫描：发现未被 pi list 列出的本地扩展。 */
	private scanLocalExtensions(): Promise<PiExtensionSummary[]> {
		return scanLocalExtensions(join(this.homeDir, ".pi", "agent", "extensions"));
	}

	/** pi list 的包源都带协议前缀；裸文件名只能走文件系统删除。 */
	private isLocalFileExtension(source: string): boolean {
		return isLocalFileExtension(source);
	}

	/** 列表缓存失效（实现见 extensionListCache.ts）：安装/卸载/开关/WSL 切换后调用。 */
	invalidateListCache(): void {
		this.listCacheStore.invalidateListCache();
	}

	/** 扩展列表（实现见 extensionListCache.ts）：命中缓存时只重跑 enabled 投影，不重跑 pi list / npm view。 */
	list(forceRefresh = false): Promise<PiExtensionListResult> {
		return this.listCacheStore.list(forceRefresh);
	}

	/** 列表组装的宿主薄包装：缓存内部经 host.loadList 回到这里，保证 manager.loadList 可被打桩。 */
	private loadList(includeVersionInfo: boolean): Promise<PiExtensionListResult> {
		return this.listCacheStore.loadList(includeVersionInfo);
	}

	// ── 更新编排薄包装（实现见 extensionUpdateService.ts）：对外仍走本类，IPC 与既有测试注入面不变。

	checkPiUpdate(): Promise<PiUpdateCheckResult> {
		return this.updateService.checkPiUpdate();
	}

	checkPiUpdateFor(settings: AppSettings): Promise<PiUpdateCheckResult> {
		return this.updateService.checkPiUpdateFor(settings);
	}

	updatePi(): Promise<PiCliUpdateResult> {
		return this.updateService.updatePi();
	}

	updateExtensions(): Promise<PiCliUpdateResult> {
		return this.updateService.updateExtensions();
	}

	/** 更新单个扩展：`pi update <source>`，source 与 list 输出一致（如 npm:context-mode）。 */
	updateExtension(source: string): Promise<PiCliUpdateResult> {
		return this.updateService.updateExtension(source);
	}

	/** 列表投影时补齐 npm 扩展的已装/最新版本（registry 快路与 npm view 回退都在编排层内部）。 */
	enrichExtensionVersion(extension: PiExtensionSummary, resolveLatestVersion: (packageName: string) => Promise<string | null>): Promise<PiExtensionSummary> {
		return this.updateService.enrichExtensionVersion(extension, resolveLatestVersion);
	}

	/** 读取 npm 扩展 package.json 的已装版本（测试与列表投影都经此入口）。 */
	readInstalledVersion(path?: string): Promise<string | undefined> {
		return this.updateService.readInstalledVersion(path);
	}

	/** 当前禁用的扩展条目（PiDeck settings，白名单模式依据）。 */
	getDisabledExtensions(): DisabledExtensionEntry[] {
		return this.getPiDeckSettings().disabledExtensions ?? [];
	}
}
