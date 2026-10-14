/**
 * 宿主级 MCP 视图的纯投影函数。
 *
 * 两条纪律（与 `docs/pideck-mcp.md` 的「数据与权限边界」一致）：
 * 1. 只做显式允许清单——不做「先整份导出再删敏感字段」，新增设置项默认不可见；
 * 2. 不产生副作用——不跑 `pi list`、不扫扩展目录、不碰网络，只读设置快照、内置清单常量
 *    与调用方已经算好的运行时列表。
 */
import { basename } from "node:path";
import type { PiDeckMcpBuiltInExtension, PiDeckMcpExtensionsView, PiDeckMcpRuntimeView, PiDeckMcpSettingsView } from "../../shared/types/piDeckMcp";
import type { AppSettings } from "../../shared/types/settings";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS, isDefaultDisabledBuiltInExtension, isHiddenBuiltInExtension } from "../extensions/builtInExtensions";

/** PiDeck 自身配置摘要。刻意不含路径类字段（customPiPath/gitExecutablePath/dshHomeDir）与凭据类字段（令牌、代理 URL、ACP env）。 */
export function buildPiDeckMcpSettingsView(settings: AppSettings): PiDeckMcpSettingsView {
	return {
		app: { language: settings.language, theme: settings.theme },
		agent: {
			backend: settings.defaultAgentBackend,
			offline: settings.piRpcOffline,
			noExtensions: settings.piRpcNoExtensions,
			noSkills: settings.piRpcNoSkills,
			lastUsedModel: settings.lastUsedModel ?? null,
			favoriteModels: [...settings.favoriteModels],
			showThinking: settings.showThinking,
			autoSessionTitle: settings.autoSessionTitle,
		},
		workspace: {
			gitManagement: settings.enableGitManagement,
			cuaEnabled: settings.cuaEnabled,
			cuaAutoApprove: settings.cuaAutoApprove,
			wslEnabled: settings.wslEnabled,
			wslDistro: settings.wslDistro,
		},
	};
}

/**
 * 内置扩展加载状态 + 用户扩展开关。
 *
 * `builtIn[].enabled` 必须与 `listActiveBuiltInExtensionPaths()` 的注入判定同口径，否则客户端会看到
 * 「已启用但实际没注入」。两处口径（顺序也一致）：内部适配器不受 removed 影响 → 隐藏成员无条件跳过 →
 * 默认关闭成员需显式 opt-in。差异只在于本函数不检查文件是否存在（那是安装完整性，不是配置状态）。
 */
export function buildPiDeckMcpExtensionsView(input: { settings: AppSettings; builtInVersion: string | null }): PiDeckMcpExtensionsView {
	// 与 listActiveBuiltInExtensionPaths 同口径：历史数据里可能存的是完整路径，先 basename 归一化再比对，
	// 否则视图会报「已启用」而实际注入被跳过。
	const normalize = (items: readonly string[]) => new Set(items.map((item) => basename(item.trim())).filter(Boolean));
	const removed = normalize(input.settings.removedBuiltInExtensions);
	const optIn = normalize(input.settings.enabledBuiltInExtensions);
	const builtIn: PiDeckMcpBuiltInExtension[] = [];
	const names: [string, boolean][] = [...BUILT_IN_EXTENSIONS.map((name): [string, boolean] => [name, false]), ...INTERNAL_BUILT_IN_EXTENSIONS.map((name): [string, boolean] => [name, true])];
	for (const [id, internal] of names) {
		const hidden = isHiddenBuiltInExtension(id);
		const defaultDisabled = isDefaultDisabledBuiltInExtension(id);
		builtIn.push({ id, enabled: !hidden && (internal || !removed.has(id)) && (!defaultDisabled || optIn.has(id)), defaultDisabled, hidden, internal });
	}
	return {
		builtInVersion: input.builtInVersion,
		injectionDisabled: input.settings.piRpcNoExtensions,
		builtIn,
		removedBuiltInExtensions: [...input.settings.removedBuiltInExtensions],
		enabledBuiltInExtensions: [...input.settings.enabledBuiltInExtensions],
		disabledExtensions: input.settings.disabledExtensions.map((entry) => ({ scope: entry.scope, source: entry.source })),
	};
}

/** 调用方（服务层）已完成授权过滤；本函数只做形状投影与计数。 */
export function buildPiDeckMcpRuntimeView(input: { runtimes: ReadonlyArray<{ sessionId: string; projectId: string; runtimeGeneration: number; status: string; createdAt: number }>; authorizedProjectCount: number }): PiDeckMcpRuntimeView {
	const runtimes = input.runtimes.map((runtime) => ({
		sessionId: runtime.sessionId,
		projectId: runtime.projectId,
		// 必须给出代次：`sessions_abort` 的 expectedRuntimeGeneration 正是从这里取的，
		// 否则客户端的乐观并发只能靠猜。
		runtimeGeneration: runtime.runtimeGeneration,
		status: runtime.status,
		// 不从 runtime state 推 busy：那是每 agent 一轮 RPC，放在每次只读请求里代价过高。
		// 代价是回答收尾的瞬间可能短暂报 idle，所以它是「值不值得等」的提示而非精确信号。
		busy: runtime.status === "starting" || runtime.status === "running",
		createdAt: runtime.createdAt,
	}));
	return {
		runtimes,
		runningCount: runtimes.length,
		activeProjectCount: new Set(runtimes.map((runtime) => runtime.projectId)).size,
		authorizedProjectCount: input.authorizedProjectCount,
	};
}
