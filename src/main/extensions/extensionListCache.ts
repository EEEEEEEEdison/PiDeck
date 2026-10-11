import type { AppSettings, PiExtensionListResult, PiExtensionSummary } from "../../shared/types";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, isDefaultDisabledBuiltInExtension, readEffectiveBuiltInExtensionsVersion, resolveBuiltInExtensionPath, type BuiltInExtensionPathRoots } from "./builtInExtensions";
import { createNpmRegistryVersionResolver } from "./npmRegistryVersion";
import type { PiRunOptions } from "./piCliRunner";

/**
 * 原生投影结果：启用状态 +（可选的）「过滤式安装」标记。
 *
 * filtered 必须在轻量投影里一并重算：列表缓存保存的是上次 `pi list` 解析的 `(filtered)`，
 * 而开关只在磁盘上改条目形态（整包停用对象 / 折回纯字符串），缓存不会自己更新；
 * pi list 又只看「条目是不是对象」，整包停用与历史空对象都会被算成 filtered。
 */
export type ExtensionNativeState = { enabled: boolean; filtered?: boolean };

/**
 * 列表组装与缓存需要宿主提供的命令缝与状态读取。
 * 所有回调都用箭头做晚绑定：测试对 manager.runPi / manager.loadList 的打桩必须继续生效。
 */
export type ExtensionListCacheHost = {
	getPiDeckSettings: () => AppSettings;
	getBuiltInRoots: () => BuiltInExtensionPathRoots | undefined;
	getNativeEnabledReader: () => ((extension: PiExtensionSummary) => ExtensionNativeState | undefined) | null;
	runPi: (args: string[], timeoutMs: number, options?: PiRunOptions) => Promise<string>;
	scanLocalExtensions: () => Promise<PiExtensionSummary[]>;
	parseListOutput: (raw: string) => PiExtensionSummary[];
	enrichExtensionVersion: (extension: PiExtensionSummary, resolveLatestVersion: (packageName: string) => Promise<string | null>) => Promise<PiExtensionSummary>;
	resolveNpmRegistryBase: () => Promise<string | null>;
	npmViewVersion: (packageName: string) => Promise<string | null>;
	removeBuiltInFile: (source: string) => Promise<void>;
	saveRemovedBuiltIn: (removedList: string[]) => Promise<void>;
	/** 真正的列表组装实现由本类提供，宿主只持有同名薄包装（保证 manager.loadList 可被打桩）。 */
	loadList: (includeVersionInfo: boolean) => Promise<PiExtensionListResult>;
};

/**
 * 扩展列表组装 + 缓存 + enabled 投影（从 ExtensionManager 迁出；架构红线：单文件 ≤600 行）。
 * 职责边界：进程调用在 piCliRunner.ts、扫描/解析在 extensionScan.ts、更新编排在 extensionUpdateService.ts；
 * 本类只管「列表怎么拼、缓存怎么失效、开关状态怎么投影」，设置写盘与文件删除经 host 回调回宿主。
 */
export class ExtensionListCache {
	constructor(private readonly host: ExtensionListCacheHost) {}

	/** 扩展列表缓存：避免每次打开配置页都重新跑 pi list + npm view。 */
	listCache: PiExtensionListResult | null = null;
	/** 缓存是否包含 npm 版本信息（仅 forceRefresh 路径会写入 true）。 */
	listCacheHasVersionInfo = false;
	/** 进行中的列表请求，用于启动预热与并发去重。 */
	listInflight: Promise<PiExtensionListResult> | null = null;
	/** 进行中请求是否为强制刷新（含版本信息）。 */
	listInflightForce = false;
	/**
	 * 列表缓存代数：安装/卸载/开关后递增。
	 * 用于丢弃失效前已发出的 in-flight 结果，避免旧列表写回缓存导致 UI 不刷新。
	 */
	listCacheGeneration = 0;
	/**
	 * 每次实际扫描递增。强制刷新可绕过轻量扫描；旧的轻量结果随后返回时，
	 * 不能覆盖已经拿到版本信息的强制刷新缓存。
	 */
	listRequestSequence = 0;

	/**
	 * 安装/卸载/开关后主动清缓存。
	 * 同时递增 generation 并断开 inflight 复用，避免旧请求完成后把已删除/已变更的列表写回。
	 */
	invalidateListCache() {
		this.listCache = null;
		this.listCacheHasVersionInfo = false;
		this.listCacheGeneration += 1;
		// 允许下一次 list() 立刻发起新请求，而不是复用失效前的 inflight。
		this.listInflight = null;
		this.listInflightForce = false;
	}

	/**
	 * 列出扩展。
	 * - forceRefresh=false：优先返回内存缓存；无缓存时做一次轻量扫描（跳过 npm view）。
	 * - forceRefresh=true：强制重新 `pi list`，并补充 npm 版本信息。
	 * - 命中缓存时也会重跑 enabled 投影（开关写盘后立刻反映），不重跑 pi list / npm view。
	 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		// 有缓存且（非强制刷新，或缓存已含版本信息）时返回。
		// 但必须重跑 enabled 投影：开关这类写操作只改设置/原生规则，主进程写完会刷新投影快照，
		// 而缓存里的 enabled 是上次扫描时算好的——直接返回整份缓存会把刚点开的开关弹回旧值。
		if (this.listCache && (!forceRefresh || this.listCacheHasVersionInfo)) {
			return this.projectCachedEnabled(this.listCache);
		}
		// 已有同级或更强请求在飞时复用，避免并发打爆 pi/npm。
		if (this.listInflight && (!forceRefresh || this.listInflightForce)) {
			return this.listInflight;
		}

		// 捕获当前代数：若请求返回前发生 install/uninstall/toggle，丢弃结果并改走最新 list。
		const generation = this.listCacheGeneration;
		const requestSequence = ++this.listRequestSequence;
		this.listInflightForce = forceRefresh;
		const request = this.host
			.loadList(forceRefresh)
			.then((result) => {
				if (generation !== this.listCacheGeneration || requestSequence !== this.listRequestSequence) {
					// 失效前或被更强刷新取代的调用方也必须拿到最新列表，
					// 否则慢到的轻量扫描会覆盖已包含版本信息的强制刷新缓存。
					return this.list(forceRefresh);
				}
				this.listCache = result;
				this.listCacheHasVersionInfo = forceRefresh;
				return result;
			})
			.finally(() => {
				// 仅清理自己：失效后新发起的请求可能已经接管 listInflight。
				if (this.listInflight === request) {
					this.listInflight = null;
					this.listInflightForce = false;
				}
			});
		this.listInflight = request;
		return request;
	}

	/**
	 * 在缓存快照上重算 enabled 状态：克隆顶层后重跑投影，不跑 pi list / npm view / 目录扫描。
	 * 开关这类只改设置的写操作走这里刷新，避免为了让开关显示新状态付一次全量扫描（秒级）。
	 */
	projectCachedEnabled(cache: PiExtensionListResult): PiExtensionListResult {
		const extensions = cache.extensions.map((extension) => ({ ...extension }));
		// 缓存路径不重读内置清单：内置版本只在热更新后变化，而热更新/扩展文件变更都会
		// invalidateListCache（下一次必然重新扫描并重算），这条路径保持纯内存。
		this.applyEnabledProjection(extensions, { refreshBuiltInVersion: false });
		return { ...cache, extensions };
	}

	/**
	 * 把 PiDeck 设置与 pi 原生过滤规则投影成 enabled 状态（纯内存，无副作用）。
	 * 既在扫描末尾调用，也在缓存快照上单独调用（见 projectCachedEnabled）。
	 * 内置版本号默认按当前生效目录重读（含 sha256 校验），缓存路径传 refreshBuiltInVersion=false 跳过。
	 */
	applyEnabledProjection(extensions: PiExtensionSummary[], options: { refreshBuiltInVersion?: boolean } = {}): void {
		// 通过 PiDeck 桌面设置标记启用状态（与 pi disabledExtensions 分离）。
		const removedBuiltIn = new Set(this.host.getPiDeckSettings().removedBuiltInExtensions ?? []);
		// 用户禁用的非内置扩展：按 scope+source 匹配（同名可在 user/project 两级独立开关）。
		const disabledExtKeys = new Set((this.host.getPiDeckSettings().disabledExtensions ?? []).map((entry) => `${entry.scope}:${entry.source}`));
		// 默认关闭（opt-in）的内置扩展：仅当用户显式开启（enabledBuiltInExtensions）才视为启用。
		const optInBuiltIn = new Set(this.host.getPiDeckSettings().enabledBuiltInExtensions ?? []);
		// 内置扩展版本：包级版本号（extensions-manifest.json，不跟 PiDeck 应用版本走），
		// 覆盖层（热更新）优先。逐行写入而非只在补齐分支赋值——内置条目可能来自
		// pi list、本地目录扫描、兜底补齐三条路径，版本只认「当前生效的那一份」。
		// 宿主回调每次调用都是新表达式，先落局部变量 TS 才能收窄掉 undefined。
		const builtInRoots = this.host.getBuiltInRoots();
		const builtInVersion = options.refreshBuiltInVersion === false || !builtInRoots ? null : readEffectiveBuiltInExtensionsVersion(builtInRoots);
		for (const ext of extensions) {
			if (ext.builtIn) {
				ext.enabled = !removedBuiltIn.has(ext.source) && (!isDefaultDisabledBuiltInExtension(ext.source) || optInBuiltIn.has(ext.source));
				if (builtInVersion) ext.currentVersion = builtInVersion;
			} else {
				// 原生投影优先（迁移后 disabledExtensions 已清空）；未装配时退回旧列表。
				const native = this.host.getNativeEnabledReader()?.(ext);
				ext.enabled = native?.enabled ?? !disabledExtKeys.has(`${ext.scope}:${ext.source}`);
				// filtered 也必须在投影里重算：缓存里存的是上次 `pi list` 解析的 (filtered)，
				// 而开关只改磁盘条目形态（整包停用对象 / 折回字符串），缓存不会自己更新。
				// 原生侧不可判定（undefined，如继承层）时保留 pi list 的结论。
				if (native?.filtered !== undefined) ext.filtered = native.filtered;
			}
		}
	}

	async loadList(includeVersionInfo: boolean): Promise<PiExtensionListResult> {
		// pi 进程列表与本地目录枚举互不依赖，并行启动把两条串行等待（子进程 spawn + 目录 IO）
		// 合并为一次往返；后续解析与 npm view 链仍等 pi 输出，行为与顺序不变。
		const [raw, localExtensions] = await Promise.all([this.host.runPi(["list"], 20_000), this.host.scanLocalExtensions()]);
		const parsed = this.host.parseListOutput(raw);
		// npm view 是扩展页变慢的主因；默认列表先跳过，只有手动刷新时再查更新。
		let piInstalled = parsed;
		if (includeVersionInfo) {
			// registry HTTP 快路：实例随本轮 loadList 创建——同包去重与基址解析都按轮次刷新，
			// 尊重用户改 npmrc 镜像后的下一轮刷新；快路失败逐包回退 npm view 子进程。
			const versionResolver = createNpmRegistryVersionResolver({
				resolveRegistryBase: () => this.host.resolveNpmRegistryBase(),
				npmViewFallback: (packageName) => this.host.npmViewVersion(packageName),
			});
			piInstalled = await Promise.all(parsed.map((extension) => this.host.enrichExtensionVersion(extension, versionResolver.resolveLatestVersion)));
		}

		// 合并，已通过 pi 安装的优先保留原条目
		const installedPaths = new Set(piInstalled.map((ext) => ext.path));
		const merged = [...piInstalled];
		for (const local of localExtensions) {
			if (!local.path || !installedPaths.has(local.path)) {
				merged.push(local);
			}
		}

		// 补充：将已禁用/文件缺失的内置扩展也纳入列表，确保用户可在 UI 中重新启用。
		const existingSources = new Set(merged.map((ext) => ext.source));
		const builtInRoots = this.host.getBuiltInRoots();
		for (const builtIn of BUILT_IN_EXTENSIONS) {
			if (!existingSources.has(builtIn)) {
				// 内置扩展经 -e 从应用资源目录注入；提供 builtInRoots 时补真实磁盘路径，
				// 让「打开目录」按钮可用（否则 path 为 undefined，UI 无法定位）。
				merged.push({
					id: `local:${builtIn}`,
					source: builtIn,
					path: builtInRoots ? resolveBuiltInExtensionPath(builtIn, builtInRoots) : undefined,
					scope: "user",
					builtIn: true,
				});
			}
		}

		// 通过 PiDeck 桌面设置标记启用状态（与 pi disabledExtensions 分离）。
		// 必须在冲突检测前初始化：后续逻辑会写回 removedBuiltInExtensions 并删磁盘文件。
		const removedBuiltIn = new Set(this.host.getPiDeckSettings().removedBuiltInExtensions ?? []);
		this.applyEnabledProjection(merged);

		// 仅检测 todo / plan / ask 固定冲突：三方包名含对应关键词时自动禁用内置版。
		// nul-redirect-fix 等其它内置扩展暂不参与冲突检测，避免 mode 等通用词误伤。
		// 注意：此处不走 disableBuiltIn（会 invalidateListCache），避免 list 请求中途 generation
		// 变化导致结果被丢弃后反复重入。
		const conflicts: { builtIn: string; thirdParty: string }[] = [];
		let removedChanged = false;
		for (const [builtInName, keyword] of BUILT_IN_CONFLICT_KEYWORDS) {
			if (removedBuiltIn.has(builtInName)) continue; // 已移除的不重复检测
			const conflicting = merged.find((ext) => !ext.builtIn && ext.enabled !== false && extensionNameMatches(ext.source, keyword));
			if (conflicting) {
				removedBuiltIn.add(builtInName);
				removedChanged = true;
				// 内置扩展已改走 -e；仍清理用户目录历史部署副本，避免与三方包双加载冲突。
				await this.host.removeBuiltInFile(builtInName).catch(() => undefined);
				conflicts.push({
					builtIn: builtInName,
					thirdParty: conflicting.source,
				});
				// 同步更新 enabled 状态
				for (const ext of merged) {
					if (ext.builtIn && ext.source === builtInName) {
						ext.enabled = false;
					}
				}
			}
		}
		if (removedChanged) {
			await this.host.saveRemovedBuiltIn([...removedBuiltIn]);
		}

		// 已标记移除但磁盘仍有残留时主动清掉，修复「UI 已禁用但仍冲突」的历史状态。
		for (const builtInName of removedBuiltIn) {
			if (!builtInName.startsWith("pi-deck-") || (INTERNAL_BUILT_IN_EXTENSIONS as readonly string[]).includes(builtInName)) continue;
			await this.host.removeBuiltInFile(builtInName).catch(() => undefined);
		}

		return { extensions: merged, raw, conflicts: conflicts.length > 0 ? conflicts : undefined };
	}
}

/**
 * 当前参与冲突检测的内置扩展与关键词。
 * todo / plan / ask：三方包名含关键词即视为功能冲突；其它内置扩展暂不自动互斥。
 */
export const BUILT_IN_CONFLICT_KEYWORDS = [
	["pi-deck-todo.ts", "todo"],
	["pi-deck-plan-mode.ts", "plan"],
	["pi-deck-goal-mode.ts", "goal"],
	["pi-deck-ask-question.ts", "ask"],
] as const;

/**
 * 固定关键词冲突匹配：清理协议/作用域后，包名是否包含指定关键词。
 * 例：rpiv-todo、my-plan-helper 命中；context-mode 不含 plan/todo 不命中。
 */
export function extensionNameMatches(source: string, keyword: string): boolean {
	const clean = source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "")
		.toLowerCase();
	return clean.includes(keyword.toLowerCase());
}
