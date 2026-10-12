/** PiDeck's optional, local-only MCP host. Management is desktop-only, never an MCP tool. */
import type { McpConfigFile } from "./mcp";
import type { AppSettings } from "./settings";

export type PiDeckMcpAccess = { enabled: boolean; projectIds: string[] };
export type PiDeckMcpProject = { id: string; name: string };
export type PiDeckMcpState = PiDeckMcpAccess & {
	running: boolean;
	projects: PiDeckMcpProject[];
	endpoint?: string;
	/** Stable, non-sensitive error code; credentials are only returned by connection(). */
	error?: string;
};
/**
 * 宿主级只读视图：与项目白名单无关（设置/内置扩展不属于任何项目）。
 * 只暴露显式允许清单里的字段——凭据、令牌、代理 URL、绝对路径、插件私有存储一律不进来。
 */
export type PiDeckMcpSettingsView = {
	app: { language: AppSettings["language"]; theme: AppSettings["theme"] };
	agent: {
		backend: AppSettings["defaultAgentBackend"];
		offline: boolean;
		noExtensions: boolean;
		noSkills: boolean;
		lastUsedModel: AppSettings["lastUsedModel"] | null;
		favoriteModels: string[];
		showThinking: boolean;
		autoSessionTitle: boolean;
	};
	workspace: {
		gitManagement: boolean;
		cuaEnabled: boolean;
		cuaAutoApprove: boolean;
		wslEnabled: boolean;
		wslDistro: string;
	};
};

/** 单个内置扩展的加载状态；`id` 是 basename，不含磁盘路径。 */
export type PiDeckMcpBuiltInExtension = {
	id: string;
	/** 按当前设置是否会注入 pi 进程（不含「文件是否存在」与 `piRpcNoExtensions` 整段关闭） */
	enabled: boolean;
	/** 默认关闭、需用户在扩展页显式开启 */
	defaultDisabled: boolean;
	/** 对用户完全隐藏：不注入，opt-in 也不能复活 */
	hidden: boolean;
	/** 内部适配器：不受用户移除影响 */
	internal: boolean;
};

export type PiDeckMcpExtensionsView = {
	/** 生效的内置扩展包版本（`extensions-manifest.json`，覆盖层优先）；清单缺失为 null */
	builtInVersion: string | null;
	/** `piRpcNoExtensions`：整段不注入内置扩展，此时 `builtIn[].enabled` 不生效 */
	injectionDisabled: boolean;
	builtIn: PiDeckMcpBuiltInExtension[];
	removedBuiltInExtensions: string[];
	enabledBuiltInExtensions: string[];
	disabledExtensions: AppSettings["disabledExtensions"];
};

export type PiDeckMcpResult<T> = { ok: true; value: T } | { ok: false; code: string };
export type PiDeckMcpDesktopApi = {
	getState: () => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	setAccess: (input: PiDeckMcpAccess) => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	connection: () => Promise<PiDeckMcpResult<McpConfigFile>>;
};
