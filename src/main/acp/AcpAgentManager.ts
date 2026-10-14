/**
 * ACP agent CLI 的进程内会话管理器:backend="acp" 的 SessionAgentGateway 实现。
 *
 * 每个 agent(会话 runtime)独占一个 ACP CLI 子进程(stdio NDJSON JSON-RPC):
 * spawn → initialize → session/new(或 session/load 恢复)→ 会话期收
 * session/update 通知投影消息、应答 session/request_permission 审批。
 *
 * 结构对照 DshAgentManager(同类第三后端),但大幅简化:无共享 host、无 mux
 * 重连、无 follow 泵——进程即会话,stop 即结束。历史不落 PiDeck 本地文件,
 * 由 agent CLI 自行持久化;重启恢复靠 acpSessionId + session/load 重放。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/ipc";
import type { AcpAgentInfo, AcpToolConfig } from "../../shared/types/acp";
import type { AgentGatewayCapability, AgentRuntimeState, AgentStatus, AgentTab, AvailableModel, CreateAgentInput } from "../../shared/types/agent";
import type { ChatMessage, SendPromptInput, SendPromptResult, SessionUiResponseInput } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { PiLocator } from "../pi/PiLocator";
import { ACP_ERROR_CODE, type AcpAgentCapabilities, type AcpConfigOption, type AcpContentBlock, type AcpRpcNotification, type AcpSessionLoadResult, type AcpSessionPromptResult, type AcpSessionSetupResult, type AcpSessionUpdate, type AcpStopReason } from "./acpProtocol";
import { AcpConnection, AcpRpcError, AcpTimeoutError } from "./AcpConnection";
import { AcpPermissionRequests } from "./AcpPermissionRequests";
import { acpPromptBlocks, appendAcpUserPrompt, initialAcpProjection, projectAcpSessionUpdate, rollbackAcpUserPrompt, settleAcpTurn, type AcpProjectionState } from "./AcpEventProjector";

/** ACP 协议握手版本(v1)。 */
const ACP_PROTOCOL_VERSION = 1;

/**
 * AUTH_REQUIRED(-32000)的统一出口：kimi/codex adapter 实测用该惯例码表示未登录。
 * 挂上 i18nKey/i18nParams/debugDetails——sendPrompt 的返回结果与 create 的 thrown
 * error（经 coordinator descriptorFromThrownError 透传）共用同一描述符结构，
 * 渲染层据此弹本地化登录引导（原文留在 debugDetails）。
 */
function authRequiredDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string }; debugDetails: string } | undefined {
	if (error instanceof AcpRpcError && error.code === ACP_ERROR_CODE.authRequired) {
		return { i18nKey: "acp.authRequired", i18nParams: { tool: tool.name }, debugDetails: error.message };
	}
	return undefined;
}

/** spawn ENOENT（CLI 未安装/不在 PATH）→ 安装引导；debugDetails 保留原文。 */
function spawnNotInstalledDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string; command: string }; debugDetails: string } | undefined {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT" || /spawn .+ ENOENT/i.test(message)) {
		return { i18nKey: "acp.toolNotInstalled", i18nParams: { tool: tool.name, command: [tool.command, ...tool.args].join(" ") }, debugDetails: message };
	}
	return undefined;
}

/** initialize/session 握手超时（首次 npx 下载 / CLI 冷启动慢）→ 中性重试引导。 */
function startupTimeoutDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string }; debugDetails: string } | undefined {
	if (error instanceof AcpTimeoutError) {
		return { i18nKey: "acp.startupTimeout", i18nParams: { tool: tool.name }, debugDetails: error.message };
	}
	return undefined;
}

/** create 抛错前的统一本地化：命中任一描述符即挂到 Error 上（coordinator 透传）。 */
function localizeCreateFailure(error: Error, tool: AcpToolConfig): void {
	const descriptor = authRequiredDescriptor(error, tool) ?? spawnNotInstalledDescriptor(error, tool) ?? startupTimeoutDescriptor(error, tool);
	if (descriptor) Object.assign(error, descriptor);
}

/** initialize/session 握手超时:CLI 冷启动(npm 包)可能要十几秒。 */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** session/prompt 回合兑底超时。测试用 deps.promptTurnTimeoutMs 注入缩短。 */
const PROMPT_TURN_TIMEOUT_MS = 10 * 60_000;

/** 流式消息 flush 节流:每 chunk 都 emit 会打爆 IPC(与 DSH 实测同因)。 */
const FLUSH_THROTTLE_MS = 80;

/** abort 后等 CLI 自行收口的宽限;超时回合仍未结算则升级强杀(CLI wedged 不处理 cancel 的实测兑底)。 */
const ABORT_ESCALATION_MS = 5_000;
/** 回合内全静默(无任何 session/update 且无挂起审批)的 stall 判定阈值;深思回合正常也有 thought/tool 流。 */
const PROMPT_STALL_TIMEOUT_MS = 90_000;
/** 每会话保留的 ACP 消息内存快照条数:stop 后重入时间线的临时数据源,激活后 load 重放覆盖。 */
const MESSAGE_SNAPSHOT_LIMIT = 16;

type AcpAgentRuntime = {
	tab: AgentTab;
	/** agent 侧 sessionId(ACP 会话身份,catalog 持久化为 acpSessionId)。 */
	acpSessionId: string;
	/** 使用的工具配置快照(会话期工具被删/改不影响运行中进程)。 */
	tool: AcpToolConfig;
	proc: import("node:child_process").ChildProcess | null;
	conn: AcpConnection | null;
	projection: AcpProjectionState;
	agentInfo: AcpAgentInfo;
	status: AgentStatus;
	/** 是否有进行中的 prompt 回合(session/prompt 尚未返回)。 */
	turnActive: boolean;
	permissions: AcpPermissionRequests;
	/** cancel 后到 prompt 结算前仍允许尾部 update，但不再接受新审批。 */
	cancelling: boolean;
	/** 本次 cancel 的发起方:user_stop=用户主动停止(空白收口属正常);stall=看门狗
	 *  代发(用户没叫停,空白回合是 CLI 异常,必须按失败收口而非谎报成功)。 */
	cancelReason: "user_stop" | "stall" | null;
	/** load 尚未成功时不发布半段历史、标题或配置，失败可完整丢弃。 */
	reloading: boolean;
	flushTimer: NodeJS.Timeout | null;
	flushPending: boolean;
	/** abort/超时升级强杀前的宽限定时器;回合正常结算时清除。 */
	abortEscalateTimer: NodeJS.Timeout | null;
	/** 回合 stall 看门狗 interval;回合结算时清除。 */
	stallTimer: NodeJS.Timeout | null;
	/** 最近一次 session/update 或回合派发的时间戳,stall 判定基准。 */
	lastUpdateAt: number;
	/** 本回合升级强杀原因;sendPrompt catch 依此定向结算(delivery=unknown + 本地化文案)。 */
	escalatedStop: "abort_repeat" | "abort_no_response" | "stall" | null;
	/** 会话标题(session_info_update / new 返回值;供 catalog 自动标题)。 */
	title?: string;
	/** session/new|load 与 set_config_option 返回的会话级配置(模型/思考档/模式)。
	 *  渲染层按 category 渲染选择器;agent 不提供时恒 undefined(回退隐藏)。 */
	configOptions?: AcpConfigOption[];
	/** session/update 串行链:投影→物化(异步落盘)→flush 必须按序完成,
	 * 否则并发的物化回写会用旧 messages 快照覆盖后到的投影结果(图片/流式块丢失)。 */
	updateChain: Promise<void>;
	/** session/set_config_option 串行链:并发的响应可能乱序,迟到的旧整表会回退
	 *  configOptions 并推过期通知;排队发送使应用顺序=请求顺序。失败不阻塞后续。 */
	configChain?: Promise<void>;
};

type AcpManagerDeps = {
	/** 解析命令启动形态(Windows .cmd 垫片还原、node 直启等)。 */
	piLocator: PiLocator;
	getProject: (id: string) => { path: string } | undefined;
	/** 读取用户登记的 ACP 工具表(settings.acpTools)。 */
	getTools: () => AcpToolConfig[];
	/**
	 * ACP 总开关(settings.acpEnabled)的运行时读口。
	 * 必须每次 create 时实时读:设置页变更立即生效,不需要重启应用。
	 */
	isEnabled: () => boolean;
	onTitleChanged?: (deckSessionId: string, title: string) => void;
	/** configOptions 变更推送(set_config_option 响应/config_option_update 通知)。 */
	onConfigOptionsChanged?: (tab: AgentTab, options: AcpConfigOption[]) => void;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** 图片落盘(base64→内容寻址 ref):生图 ImageBlobStore 的最小结构化依赖,便于单测注入假实现。 */
	imageStore?: { put(data: string, mimeType: string): Promise<string | null> };
	/** session/prompt 回合超时(默认 10 分钟)。测试注入短值验证超时补发 session/cancel。 */
	promptTurnTimeoutMs?: number;
	/** initialize/session-new/load 握手超时(默认 60s)。测试注入短值验证启动超时本地化。 */
	handshakeTimeoutMs?: number;
	/** permission expiry 的测试注入，不新增持久化设置。 */
	permissionTimeoutMs?: number;
	/** abort 升级强杀宽限(默认 5s)。测试注入短值验证升级路径。 */
	abortEscalationMs?: number;
	/** 回合无输出 stall 判定阈值(默认 90s)。测试注入短值验证看门狗。 */
	promptStallTimeoutMs?: number;
};

export class AcpAgentManager implements SessionAgentGateway {
	readonly backend = "acp" as const;
	/**
	 * 首版能力:仅 getCommands(available_commands_update 投影)。
	 * fork/compact/exportHtml 等待 ACP 生态补齐对应方法后再开(能力门控是硬规则,
	 * UI 按能力禁用,缺失项不得硬造等价物)。
	 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set<AgentGatewayCapability>(["getCommands"]);

	private readonly runtimes = new Map<string, AcpAgentRuntime>();
	/** acpSessionId → 最近一次 flush 的消息快照（cap MESSAGE_SNAPSHOT_LIMIT）：
	 *  stop/升级强杀后 runtime 删除，重入会话时 readMessagesByAcpSessionId 的临时数据源。 */
	private readonly messageSnapshots = new Map<string, ChatMessage[]>();
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();

	constructor(private readonly deps: AcpManagerDeps) {}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	private emit(channel: string, payload: unknown): void {
		for (const listener of this.outputListeners) listener(channel, payload);
	}

	list(): AgentTab[] {
		return [...this.runtimes.values()].map((runtime) => ({ ...runtime.tab, status: runtime.status }));
	}

	getTool(agentId: string): AcpToolConfig | undefined {
		return this.runtimes.get(agentId)?.tool;
	}

	getAgentInfo(agentId: string): AcpAgentInfo | undefined {
		return this.runtimes.get(agentId)?.agentInfo;
	}

	readMessages(agentId: string): ChatMessage[] {
		return this.runtimes.get(agentId)?.projection.messages ?? [];
	}

	/**
	 * 按 agent 侧 sessionId 找消息。runtime 在场返回全量投影；已停止（stop/升级强杀）
	 * 返回最近一次 flush 的内存快照（cap MESSAGE_SNAPSHOT_LIMIT）——重入会话时时间线
	 * 不再空白，激活后 session/load 重放会覆盖为完整历史（无 load 能力则快照即全部可见历史）。
	 */
	readMessagesByAcpSessionId(acpSessionId: string): ChatMessage[] {
		if (!acpSessionId) return [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.acpSessionId === acpSessionId) return runtime.projection.messages;
		}
		return this.messageSnapshots.get(acpSessionId) ?? [];
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.readMessages(agentId);
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		// ACP v1 无改名请求;标题由 agent 侧 session_info_update 维护,这里只改本地 tab。
		const runtime = this.requireRuntime(agentId);
		runtime.tab = { ...runtime.tab, title: name };
		this.emit(ipcChannels.agentsState, this.list());
		return { ...runtime.tab };
	}

	async compact(): Promise<AgentRuntimeState> {
		// capabilities 不含 compact,UI 已禁用入口;此实现仅兑现接口契约。
		throw new Error("ACP backend does not support compaction");
	}

	async prepareResendFromMessage(): Promise<{ text: string; images?: ChatMessage["images"] }> {
		// ACP 历史存 agent 侧,PiDeck 无法重写;capabilities 不含 editMessage/重发。
		throw new Error("ACP backend does not support message resend");
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return [];
	}

	async forkSession(): Promise<unknown> {
		throw new Error("ACP backend does not support forking");
	}

	async setModel(agentId: string, _provider: string, _modelId: string): Promise<unknown> {
		// ACP v1 模型选择走 session/set_config_option(configOptions 规范路径),
		// 不经 pi 的 setModel;no-op 保住 applyLatestPreferences 链路。
		this.requireRuntime(agentId);
		return {};
	}

	/** 当前会话配置枚举(模型/思考档/模式);agent 未提供时 undefined(渲染层隐藏选择器)。 */
	getSessionConfigOptions(agentId: string): AcpConfigOption[] | undefined {
		return this.requireRuntime(agentId).configOptions;
	}

	/** 下发配置选择并返回 agent 回传的完整 configOptions(规范:响应必带整表)。 */
	async applyConfigOption(agentId: string, optionId: string, value: string | boolean): Promise<AcpConfigOption[]> {
		const runtime = this.requireRuntime(agentId);
		// 串行化同一 runtime 的配置写入:乱序响应下迟到的旧整表会回退 runtime.configOptions
		// 并通过通知推过期状态(复核发现的乱序回退缺陷);排队后通知顺序=请求顺序。
		const previous = (runtime.configChain ?? Promise.resolve()).catch(() => undefined);
		const operation = previous.then(() => this.performConfigOptionRequest(runtime, optionId, value));
		runtime.configChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** 真正发出 session/set_config_option;在串行链上迟到执行,需重新校验 runtime 归属与连接。 */
	private async performConfigOptionRequest(runtime: AcpAgentRuntime, optionId: string, value: string | boolean): Promise<AcpConfigOption[]> {
		if (this.runtimes.get(runtime.tab.id) !== runtime) throw new Error("ACP agent is not running");
		const conn = runtime.conn;
		if (!conn || conn.isClosed()) throw new Error("ACP agent is not running");
		const result = (await conn.request("session/set_config_option", { sessionId: runtime.acpSessionId, configId: optionId, value }, 15_000)) as { configOptions?: AcpConfigOption[] } | null;
		if (!result || !Array.isArray(result.configOptions)) throw new Error("session/set_config_option returned no configOptions");
		runtime.configOptions = result.configOptions;
		this.deps.onConfigOptionsChanged?.(runtime.tab, result.configOptions);
		return result.configOptions;
	}

	async setThinking(agentId: string, _level: string): Promise<unknown> {
		this.requireRuntime(agentId);
		return {};
	}

	// ── SessionAgentGateway ────────────────────────────────────────────────

	async create(input: CreateAgentInput): Promise<AgentTab> {
		// 开关运行时判定:关闭时拒绝 spawn(渲染层已隐藏 ACP 入口,这里是边界防御;
		// 也覆盖「从历史恢复 ACP 会话」这类不经过后端下拉的启动路径)。
		if (!this.deps.isEnabled()) throw new Error("ACP backend is disabled (settings off or stable channel)");
		const project = this.deps.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		// 工具选择:agentPreset 字段承载 AcpToolConfig.id(coordinator 已归一传入)。
		const toolId = input.agentPreset ?? "";
		const tool = this.deps.getTools().find((candidate) => candidate.id === toolId && candidate.enabled);
		// 工具被删/禁用：会话绑定还在（acpToolId 落 catalog），给明确引导而不是裸 id 报错。
		if (!tool) throw Object.assign(new Error(`ACP tool not found or disabled: ${toolId || "(none)"}`), { i18nKey: "acp.toolMissing", i18nParams: { tool: toolId || "(none)" } });
		const cwd = project.path;

		const invocation = this.deps.piLocator.createInvocation(tool.command, tool.args);
		// 工具级 env(如 codex-acp 的 ZAI_CODING_KEY)叠加在基础进程 env 之上;
		// 值可能含密钥,绝不进日志。
		const env = { ...this.deps.piLocator.createProcessEnv(), ...(tool.env ?? {}) };
		this.deps.logger?.info("acp", "Spawning ACP agent", { tool: tool.name, command: invocation.command, args: invocation.args });
		// ACP 规范:client 透传 stdio 的其余输出(日志走 stderr);windowsHide 对齐全项目惯例。
		const proc = spawn(invocation.command, invocation.args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env, windowsHide: true });
		// spawn 失败/被杀必须挂 error 监听(硬规则:未处理 error 事件崩主进程)。
		const spawnFailure = new Promise<never>((_, reject) => {
			proc.once("error", (error) => reject(error));
		});
		const conn = new AcpConnection(proc.stdin, proc.stdout);
		proc.on("error", (error) => conn.close(error));
		proc.stderr?.on("data", (chunk: Buffer) => {
			// CLI 诊断日志(stderr)只进主进程日志,不上时间线。
			const text = chunk.toString("utf8").trim();
			if (text) this.deps.logger?.info("acp", `[${tool.name}] ${text.slice(0, 2000)}`);
		});
		// Node 的 exit 早于 stdout 排空；close 才能收口，否则末批 update/result 会被丢弃。
		proc.once("close", (code, signal) => {
			conn.finish(new Error(`ACP agent exited (code=${code} signal=${signal})`));
		});

		const agentId = `acp:${randomUUID()}`;
		const runtime: AcpAgentRuntime = {
			tab: {
				id: agentId,
				projectId: input.projectId,
				cwd,
				title: input.title ?? `${tool.name} 会话`,
				status: "starting",
				deckSessionId: input.deckSessionId,
				backend: "acp",
				agentPreset: tool.id,
				noSession: input.noSession,
				createdAt: Date.now(),
			},
			acpSessionId: "",
			tool,
			proc,
			conn,
			projection: initialAcpProjection(),
			updateChain: Promise.resolve(),
			agentInfo: { capabilities: { loadSession: false, agentThought: false, sessionList: false, promptImage: false }, protocolVersion: ACP_PROTOCOL_VERSION },
			status: "starting",
			turnActive: false,
			permissions: new AcpPermissionRequests(conn, (event) => this.emit(ipcChannels.agentsUiRequest, { agentId, ...event }), this.deps.permissionTimeoutMs),
			cancelling: false,
			cancelReason: null,
			reloading: false,
			flushTimer: null,
			flushPending: false,
			abortEscalateTimer: null,
			stallTimer: null,
			lastUpdateAt: 0,
			escalatedStop: null,
		};
		this.runtimes.set(agentId, runtime);
		this.emit(ipcChannels.agentsState, this.list());

		try {
			await this.handshake(runtime, input.acpSessionId, cwd, spawnFailure);
		} catch (error) {
			this.runtimes.delete(agentId);
			this.killProcess(runtime);
			this.emit(ipcChannels.agentsState, this.list());
			const thrown = error instanceof Error ? error : new Error(String(error));
			// AUTH_REQUIRED / CLI 未安装(ENOENT) / 握手超时：附描述符再抛，
			// coordinator 透传为本地化引导 toast（不命中的错误原样透出原文）。
			localizeCreateFailure(thrown, tool);
			throw thrown;
		}

		this.wireConnection(runtime);
		if (runtime.title && runtime.tab.deckSessionId) this.deps.onTitleChanged?.(runtime.tab.deckSessionId, runtime.title);
		runtime.status = "idle";
		runtime.tab.status = "idle";
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(agentId);
		// load 重放/新建即回显:attach 会话历史立即可见。
		this.flushMessages(runtime, true);
		return { ...runtime.tab };
	}

	/** initialize + session/new(或 load);失败由调用方清理进程。 */
	private async handshake(runtime: AcpAgentRuntime, resumeSessionId: string | undefined, cwd: string, spawnFailure: Promise<never>): Promise<void> {
		const conn = runtime.conn;
		if (!conn) throw new Error("ACP connection missing");
		// 通知在握手后才有意义,但先注册分发(部分 CLI 握手期即可能推 update)。
		conn.on("notification", (notification: { method?: string }) => {
			// config_option_update:agent 主动推送配置变更(如限流降级模型),不进投影链,
			// 直接整表替换并通知渲染层(会话期可能无 in-flight set 请求,不能只在响应里更新)
			if (notification.method === "config_option_update") {
				const params = (notification as { params?: { sessionId?: string; configOptions?: AcpConfigOption[] } }).params;
				if (runtime.status !== "closed" && !runtime.reloading && params?.sessionId === runtime.acpSessionId && Array.isArray(params.configOptions)) {
					runtime.configOptions = params.configOptions;
					this.deps.onConfigOptionsChanged?.(runtime.tab, params.configOptions);
				}
				return;
			}
			// 串行链:物化(异步落盘)回写 projection 前不能让下一个 update 先投影,
			// 否则旧快照覆盖新消息;链兑 catch,单条失败不断链。
			runtime.updateChain = runtime.updateChain
				.then(() => this.handleSessionUpdate(runtime, notification as AcpRpcNotification))
				.catch(() => {
					// handleSessionUpdate 自身已对物化降级,这里只兑 unexpected 异常
				});
		});
		conn.on("protocol-error", (line: unknown) => {
			// stdout 混入非 JSON(CLI banner/进度条):不致命,记录即可;ACP 规范允许 client 忽略。
			this.deps.logger?.warn("acp", `[${runtime.tool.name}] non-JSON stdout ignored: ${String(line).slice(0, 300)}`);
		});

		const initTask = conn.request(
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			},
			this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
		);
		const initResult = (await Promise.race([initTask, spawnFailure])) as { protocolVersion?: unknown; agentCapabilities?: AcpAgentCapabilities; agentInfo?: { name?: unknown } | null } | null;
		if (initResult?.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocolVersion: ${String(initResult?.protocolVersion)}`);
		const agentCaps = initResult.agentCapabilities ?? {};
		runtime.agentInfo = {
			name: typeof initResult.agentInfo?.name === "string" ? initResult.agentInfo.name : undefined,
			capabilities: {
				loadSession: agentCaps.loadSession === true,
				agentThought: agentCaps.promptCapabilities?.agentThought === true,
				sessionList: typeof agentCaps.sessionCapabilities?.list === "object" && agentCaps.sessionCapabilities.list !== null,
				promptImage: agentCaps.promptCapabilities?.image === true,
			},
			protocolVersion: ACP_PROTOCOL_VERSION,
		};

		// session/new 或 session/load。load 失败(id 在 agent 侧已不存在)回退新建。
		// mcpServers 必传空数组: ACP v1 规范该字段必填, opencode 的 zod 校验缺它直接
		// -32602 Invalid params(实测), 会话创建即失败冒泡成首条消息发送失败。
		let setup: AcpSessionLoadResult | undefined;
		if (resumeSessionId && runtime.agentInfo.capabilities.loadSession) {
			// ACP 规范:agent 先经 session/update 重放历史、再回 load 响应。重放期 client
			// 手里只有请求参数里的旧 sessionId,必须提前挂到 runtime 上,否则
			// handleSessionUpdate 的 sessionId 过滤会把整段重放历史全部丢弃。
			runtime.acpSessionId = resumeSessionId;
			runtime.reloading = true;
			try {
				const loaded = (await conn.request("session/load", { sessionId: resumeSessionId, cwd, mcpServers: [] }, this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)) as AcpSessionLoadResult;
				await runtime.updateChain;
				// 标准 load 响应无 sessionId；保留请求身份。兼容明确回传身份的旧 CLI。
				setup = { ...loaded, sessionId: typeof loaded?.sessionId === "string" && loaded.sessionId ? loaded.sessionId : resumeSessionId };
			} catch (error) {
				// 排空已经开始的物化再丢弃；否则在途旧快照能污染 session/new。
				runtime.acpSessionId = "";
				await runtime.updateChain;
				runtime.projection = initialAcpProjection();
				runtime.title = undefined;
				runtime.configOptions = undefined;
				this.deps.logger?.warn("acp", `session/load failed, falling back to session/new: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				runtime.reloading = false;
			}
		}
		if (!setup?.sessionId) {
			setup = (await conn.request("session/new", { cwd, mcpServers: [] }, this.deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)) as AcpSessionSetupResult;
		}
		if (!setup?.sessionId || typeof setup.sessionId !== "string") throw new Error("ACP session/new returned no sessionId");
		runtime.acpSessionId = setup.sessionId;
		// tab.sessionId 镜像 agent 侧会话 id(与 DSH 的 tab.sessionId=host id 同契约):
		// SessionRuntimeCoordinator 的 buildAttachPatch / prompt dispatch / restart 都以
		// 它为键把 acpSessionId 落 catalog。缺失则 acpSessionId 永不持久化,重开历史
		// 会话只能 session/new 新建,历史全部丢失。
		runtime.tab.sessionId = setup.sessionId;
		if (typeof setup.title === "string" && setup.title.trim()) runtime.title = setup.title.trim();
		// configOptions 规范路径(取代旧 modes):模型/思考档/模式枚举,渲染层选择器数据源
		runtime.configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : runtime.configOptions;
		await runtime.updateChain;
		runtime.projection = settleAcpTurn(runtime.projection, "end_turn");
	}

	/** 会话期请求处理注册(session/request_permission 等)。 */
	private wireConnection(runtime: AcpAgentRuntime): void {
		const conn = runtime.conn;
		if (!conn) return;
		conn.handleRequest("session/request_permission", (params, rpcId) => runtime.permissions.request(params, rpcId, runtime.acpSessionId, runtime.cancelling || runtime.status === "closed"));
		// fs/read_text_file 等未声明能力,规范约定回 method not found(AcpConnection 默认行为)。
		conn.on("closed", (error: Error | null) => {
			if (runtime.conn && runtime.conn.isClosed() && runtime.status === "closed") return;
			this.clearTurnTimers(runtime);
			runtime.status = "error";
			runtime.tab.status = "error";
			runtime.turnActive = false;
			// 进程死掉:结束流式消息、结算 pending 审批为 cancelled、推终态。
			// 结算排到 update 链尾:死亡前最后一批 update 可能还在链上物化,
			// 直接 settle 会把未消费的流式块拆成新回合。
			runtime.updateChain = runtime.updateChain
				.then(() => {
					runtime.projection = settleAcpTurn(runtime.projection, "error");
					this.failPendingPermissions(runtime);
					this.flushMessages(runtime, true);
					this.emit(ipcChannels.agentsState, this.list());
					this.emitRuntimeState(runtime.tab.id);
					if (error) this.deps.logger?.warn("acp", `[${runtime.tool.name}] connection closed: ${error.message}`);
				})
				.catch(() => {
					// 结算链兜底:任何异常也不留 rejected promise 挂在链上
				});
		});
	}

	private async handleSessionUpdate(runtime: AcpAgentRuntime, notification: AcpRpcNotification): Promise<void> {
		if (runtime.status === "closed" || !this.runtimes.has(runtime.tab.id) || notification.method !== "session/update") return;
		if (notification.params?.sessionId !== runtime.acpSessionId) return;
		// 回合中收到任何 update 都刷新活跃时间：stall 看门狗只关心全静默。
		if (runtime.turnActive) runtime.lastUpdateAt = Date.now();
		const rawUpdate = notification.params.update;
		if (!rawUpdate || typeof rawUpdate !== "object" || !("sessionUpdate" in rawUpdate) || typeof rawUpdate.sessionUpdate !== "string") return;
		const update = rawUpdate as AcpSessionUpdate;
		if (update.sessionUpdate === "config_option_update") {
			if (Array.isArray(update.configOptions)) {
				runtime.configOptions = update.configOptions;
				if (!runtime.reloading) this.deps.onConfigOptionsChanged?.(runtime.tab, update.configOptions);
			}
			return;
		}
		// 实时 prompt 已在本地记录完整 user 消息；echo 仅用于历史恢复，不能重复追加。
		if (runtime.turnActive && update.sessionUpdate === "user_message_chunk") return;
		runtime.projection = projectAcpSessionUpdate(runtime.projection, update, runtime.tab.id);
		// 图片物化:投影器产出的 base64 图在进消息缓存前落盘成 ref(同生图「base64 不进历史」契约);
		// 失败保留 data 形态展示(ACP 不写 JSONL,内联形态只是内存开销,不违反存储约束)。
		await this.materializeTouchedImages(runtime);
		if (this.runtimes.get(runtime.tab.id) !== runtime) return;
		// catalog 重载中：标题只回写投影状态，不动 tab/catalog（避免旧目录扫描与投影竞争）。
		if (runtime.reloading) {
			runtime.title = runtime.projection.title ?? runtime.title;
			return;
		}
		// plan/todos 与 usage 变更不走 messages 通道，主动 emit 才能让待办列表/上下文仪表即时刷新。
		if (runtime.projection.todos || update.sessionUpdate === "usage_update") this.emitRuntimeState(runtime.tab.id);
		this.applyProjectionTitle(runtime);
		this.scheduleFlush(runtime);
	}

	/**
	 * 投影标题 → runtime / tab / catalog 同步。
	 * 两个来源：agent 的 session_info_update（last-wins）与首条 prompt 的兜底标题
	 * （见 appendAcpUserPrompt）；catalog 回写由 deps.onTitleChanged 完成。
	 */
	private applyProjectionTitle(runtime: AcpAgentRuntime): void {
		const title = runtime.projection.title;
		if (!title || title === runtime.title) return;
		runtime.title = title;
		runtime.tab.title = title;
		if (runtime.tab.deckSessionId) this.deps.onTitleChanged?.(runtime.tab.deckSessionId, title);
	}

	/** 把本轮投影 touched 消息里的 data 形态图片替换成落盘 ref;仅替换成功项,失败保留原样。 */
	private async materializeTouchedImages(runtime: AcpAgentRuntime): Promise<void> {
		const store = this.deps.imageStore;
		const touched = runtime.projection.lastTouched;
		if (!store || !touched || touched.length === 0) return;
		let messages = runtime.projection.messages;
		let mutated = false;
		for (const index of touched) {
			const message = messages[index];
			if (!message?.images?.length) continue;
			const images = await Promise.all(
				message.images.map(async (image) => {
					if (image.type !== "image" || image.ref || typeof image.data !== "string") return image;
					try {
						const ref = await store.put(image.data, image.mimeType);
						return ref ? { type: "image" as const, mimeType: image.mimeType, ref } : image;
					} catch {
						return image;
					}
				}),
			);
			if (mutated || images.some((image, i) => image !== message.images?.[i])) {
				messages = [...messages];
				messages[index] = { ...message, images };
				mutated = true;
			}
		}
		if (mutated) runtime.projection = { ...runtime.projection, messages };
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		if (!runtime.conn || runtime.conn.isClosed()) {
			return { accepted: false, error: "ACP agent process is not running", delivery: "rejected", i18nKey: "acp.processNotRunning", i18nParams: { tool: runtime.tool.name } };
		}
		if (input.agentMessage) {
			return { accepted: false, error: "Host instructions are not supported by ACP backend", delivery: "rejected", i18nKey: "acp.hostInstructionsUnsupported", i18nParams: { tool: runtime.tool.name } };
		}
		// 图片按能力门控：agent 未声明 promptCapabilities.image 时发 image 块只会换来整回合
		// 协议错误（raw JSON-RPC 文本对用户无意义）；拒收并回填草稿，用本地化文案说明。
		if (input.images?.length && !runtime.agentInfo.capabilities.promptImage) {
			return { accepted: false, error: `ACP agent ${runtime.tool.name} does not accept image input`, delivery: "rejected", i18nKey: "acp.imagesNotSupported", i18nParams: { tool: runtime.tool.name } };
		}
		if (runtime.turnActive) {
			return { accepted: false, error: "ACP agent is still responding; stop or wait for the current turn", delivery: "rejected", i18nKey: "acp.turnBusy", i18nParams: { tool: runtime.tool.name } };
		}
		const prompt = acpPromptBlocks(input.message, input.images);
		// 本回合结算 stopReason 的快照:成功路径的空白回合守卫在 try 外使用,需提前记录。
		let settledStopReason: AcpStopReason = "end_turn";
		// 用户消息先落投影:ACP 规范不保证 agent 回显 user_message_chunk(OpenCode 等根本不发),
		// 而 agents:message 是全量替换语义,主进程不落条目的话渲染层乐观气泡会被第一次 flush 抹掉。
		const messagesBeforeSeed = runtime.projection.messages.length;
		runtime.projection = appendAcpUserPrompt(runtime.projection, input.message, input.images, runtime.tab.id);
		const seededIndex = runtime.projection.messages.length > messagesBeforeSeed ? messagesBeforeSeed : -1;
		this.applyProjectionTitle(runtime);
		runtime.turnActive = true;
		runtime.cancelling = false;
		runtime.cancelReason = null;
		runtime.escalatedStop = null;
		runtime.status = "running";
		runtime.tab.status = "running";
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 先 flush 用户气泡再走物化链:base64→ref 可能慢,不等它,渲染层立即看到本条消息;
		// 物化完成后下一次 flush 把快照里的 base64 换成 ref(内存形态不违反「base64 不进存储」契约)。
		// turnActive 必须在物化前置位:abort 依赖它置 cancelling,晚置会把 abort 的取消意图抹掉。
		this.flushMessages(runtime, true);
		try {
			// 与 update 共用物化链，防止本地图片异步回写覆盖 agent 首批响应。
			runtime.updateChain = runtime.updateChain.then(() => this.materializeTouchedImages(runtime));
			await runtime.updateChain;
			if (this.runtimes.get(runtime.tab.id) !== runtime || runtime.conn.isClosed()) throw new Error("ACP agent process stopped before prompt dispatch");
			if (runtime.cancelling) throw new Error("ACP prompt cancelled before dispatch");
			this.flushMessages(runtime, true);
			// 回合 stall 看门狗:全静默(无 update/无挂起审批)超阈值先 cancel 再升级强杀,
			// 否则 CLI 侧流错误吞掉回合(opencode 实测)时 UI 只能等 10 分钟兑底超时。
			this.armStallWatchdog(runtime);
			// 长回合请求不套默认 60s 短超时:深思模型单回合可超分钟级,超时应由 abort/stop/连接死亡驱动;
			// 10 分钟兑底防真悬死(实测 codex-acp 思考型回合 >60s,见 scripts/acpLiveSmoke.mjs)。
			// 可注入 deps.promptTurnTimeoutMs 供测试缩短。
			const result = (await runtime.conn.request("session/prompt", { sessionId: runtime.acpSessionId, prompt }, this.deps.promptTurnTimeoutMs ?? PROMPT_TURN_TIMEOUT_MS)) as AcpSessionPromptResult;
			this.clearTurnTimers(runtime);
			// 结算前先排空 update 链:result 帧与末批 update 同为 stdout 行序分发,
			// 但链上每步含异步物化,settle 提前会把在途流式块拆成新回合。
			await runtime.updateChain;
			settledStopReason = result?.stopReason ?? "end_turn";
			runtime.projection = settleAcpTurn(runtime.projection, settledStopReason);
		} catch (error) {
			await runtime.updateChain;
			this.clearTurnTimers(runtime);
			// 派发失败（JSON-RPC 拒绝 / 连接死）且 agent 未产出任何内容：撤回刚落的用户条目，
			// 否则时间线会留一条没有回复的「幽灵消息」，而渲染层已把草稿回填输入框（会重发）。
			// 用户主动取消(cancelling)不撤回:语义同 pi 后端 abort,用户消息留在时间线。
			// 结算用 cancelled,与 abort 语义一致，不算错误。
			if (!runtime.cancelling) runtime.projection = rollbackAcpUserPrompt(runtime.projection, seededIndex);
			runtime.projection = settleAcpTurn(runtime.projection, runtime.cancelling ? "cancelled" : "error");
			runtime.turnActive = false;
			runtime.permissions.cancelAll();
			// 请求超时 ≠ agent 侧回合结束:agent 仍在跑旧回合,后续 session/prompt 会一直
			// 排在它后面反复超时(opencode 卡死实测);abort() 也因 turnActive 已清而 no-op。
			// 超时必须补发 session/cancel 让 agent 收口旧回合,否则会话永久卡死。
			if (error instanceof AcpTimeoutError && runtime.conn && !runtime.conn.isClosed()) {
				runtime.cancelling = true;
				try {
					runtime.conn.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "turn_timeout" });
				} catch {
					// 通知失败只能放弃:连接层随后会自行死亡/关闭并结算。
				}
			}
			// 连接死亡等外部终态(error/closed)由 closed handler 结算,不回 idle;
			// 仅本回合请求失败(如 JSON-RPC 拒绝)从 running 回 idle。
			if (runtime.status === "running") {
				runtime.status = "idle";
				runtime.tab.status = "idle";
			}
			this.flushMessages(runtime, true);
			this.emit(ipcChannels.agentsState, this.list());
			this.emitRuntimeState(input.agentId);
			const message = error instanceof Error ? error.message : String(error);
			const hasOutput = runtime.projection.messages.slice(seededIndex + 1).some((entry) => entry.role === "assistant" || entry.role === "tool");
			// 升级强杀（abort 宽限超时/二次停止/stall）：用户消息已留在时间线（cancelling 不回滚），
			// delivery=unknown（CLI 是否已处理不可知，不回填草稿避免重发重复），文案本地化并带原因。
			if (runtime.escalatedStop) {
				return {
					accepted: false,
					error: message,
					delivery: "unknown",
					i18nKey: runtime.escalatedStop === "stall" ? "acp.stallForceStopped" : "acp.abortForceStopped",
					i18nParams: { tool: runtime.tool.name },
					debugDetails: `escalated=${runtime.escalatedStop}: ${message}`,
				};
			}
			// AUTH_REQUIRED（凭据过期等回合期失败）：描述符随拒收结果透出登录引导。
			const descriptor = authRequiredDescriptor(error, runtime.tool);
			return { accepted: false, error: message, delivery: hasOutput || error instanceof AcpTimeoutError ? "unknown" : "rejected", ...(descriptor ?? {}) };
		}
		runtime.turnActive = false;
		runtime.permissions.cancelAll();
		if (runtime.status === "running") {
			runtime.status = "idle";
			runtime.tab.status = "idle";
		}
		this.flushMessages(runtime, true);
		this.emit(ipcChannels.agentsState, this.list());
		this.emitRuntimeState(input.agentId);
		// 成功结算 ≠ 有可见输出：部分 CLI 因自身事件流竞态会正常回 end_turn 却漏掉全部
		// session/update（OpenCode 1.15.4 /event 订阅竞态实测：消息已被处理但 client 一无所获，
		// UI 只剩本地用户气泡、草稿已清空、还谎报成功）。回合已确定结束且无任何产出，
		// 按 rejected 收口并回滚本地用户条目：渲染层回填草稿，用户升级 CLI 后可安全重发。
		// 用户主动停止(cancelling 且来源 user_stop,CLI 回 cancelled)不在此列:语义同 pi 后端
		// abort,正常收口;看门狗 stall 代发的 cancel 不豁免——那就是本守卫要抓的异常形态。
		const hasOutput = runtime.projection.messages.slice(seededIndex + 1).some((entry) => entry.role === "assistant" || entry.role === "tool");
		if (!hasOutput && runtime.cancelReason !== "user_stop") {
			runtime.projection = rollbackAcpUserPrompt(runtime.projection, seededIndex);
			this.flushMessages(runtime, true);
			const error = `ACP agent ${runtime.tool.name} completed the turn without any output`;
			this.deps.logger?.warn("acp", error, { tool: runtime.tool.name, sessionId: runtime.acpSessionId, stopReason: settledStopReason });
			return { accepted: false, error, delivery: "rejected", i18nKey: "acp.emptyTurn", i18nParams: { tool: runtime.tool.name } };
		}
		return { accepted: true };
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.conn || runtime.conn.isClosed() || !runtime.turnActive) return;
		if (runtime.cancelling) {
			// 二次停止:cancel 已发出但回合仍未收口(CLI wedged),不再等待,立即强杀。
			// 强杀 → conn.close 拒绝在途 session/prompt → sendPrompt catch 定向结算。
			this.forceStopRuntime(runtime, "abort_repeat");
			return;
		}
		// session/cancel 后仍接收尾部 update，原 prompt 返回才收口；审批则立即全部结算。
		runtime.cancelling = true;
		runtime.cancelReason = "user_stop";
		runtime.permissions.cancelAll();
		runtime.conn.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "user_stop" });
		// cancel 只是通知:CLI 可能既不处理也不回包(opencode 流错误后实测 wedged)。
		// 宽限内回合自行结算则定时器被清;超时升级强杀,保证「停止」最终必然生效。
		this.scheduleAbortEscalation(runtime, "abort_no_response");
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		runtime.status = "closed";
		runtime.tab.status = "closed";
		this.failPendingPermissions(runtime);
		this.killProcess(runtime);
		// 删除前先推一次终态:stop()/abort 升级强杀都走这里,渲染层需要 closed 事件把
		// 会话从 running 收口(删除后的 list() 不再含该 agent,不会产生逐 agent 事件;
		// 用户主动停止另有 coordinator 的 detach 事件,此推送与其幂等)。
		this.emit(ipcChannels.agentsState, this.list());
		this.runtimes.delete(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	async stopAll(): Promise<void> {
		for (const agentId of [...this.runtimes.keys()]) await this.stop(agentId);
	}

	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		const input: CreateAgentInput = {
			projectId: runtime.tab.projectId,
			title: runtime.tab.title,
			deckSessionId: runtime.tab.deckSessionId,
			backend: "acp",
			agentPreset: runtime.tool.id,
			acpSessionId: runtime.agentInfo.capabilities.loadSession ? runtime.acpSessionId : undefined,
			noSession: runtime.tab.noSession,
		};
		await this.stop(agentId);
		return this.create(input);
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.permissions.respond(requestId, response)) return { accepted: false, reason: "no-pending-request" };
		return { accepted: true };
	}

	notifyAskPending(_agentId: string, _sessionId: string, _sessionTitle: string, _question: string): void {
		// 桌面通知由 SessionRuntimeCoordinator.observeRuntimeEvent 统一触发。
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		return this.buildRuntimeState(runtime);
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		if (this.runtimes.has(agentId)) this.emitRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		// ACP v1 无模型枚举方法(各 CLI 自管模型);声明空目录,UI 走 agent 自身。
		this.requireRuntime(agentId);
		return [];
	}

	async listCommands(agentId: string): Promise<PiCommand[]> {
		const runtime = this.runtimes.get(agentId);
		return runtime?.projection.commands ?? [];
	}

	/** SessionAgentGateway.getCommands(可选能力 getCommands):available_commands_update 投影。 */
	async getCommands(agentId: string): Promise<PiCommand[]> {
		return this.listCommands(agentId);
	}

	// ── 内部 ───────────────────────────────────────────────────────────────

	private requireRuntime(agentId: string): AcpAgentRuntime {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No ACP runtime: ${agentId}`);
		return runtime;
	}

	private buildRuntimeState(runtime: AcpAgentRuntime): AgentRuntimeState {
		const usage = runtime.projection.usage;
		return {
			isStreaming: runtime.turnActive,
			isTurnActive: runtime.turnActive,
			// 工具名作展示模型位：让底栏显示当前 CLI（如 "Gemini CLI"）。
			modelName: runtime.tool.name,
			provider: "acp",
			modelId: runtime.tool.id,
			todos: runtime.projection.todos,
			// usage_update（opencode/kimi 等非标准但广泛流传的会话用量通知）→ 上下文仪表数据源。
			...(usage?.used !== undefined ? { contextTokens: usage.used } : {}),
			...(usage?.size !== undefined ? { contextWindow: usage.size } : {}),
			...(usage?.used !== undefined && usage?.size !== undefined ? { contextPercent: Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 1000) / 10)) } : {}),
			...(usage?.costAmount !== undefined ? { cost: usage.costAmount } : {}),
		};
	}

	private emitRuntimeState(agentId: string): void {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// runtime state 与 agentsState 同步推送：渲染层底栏状态依赖两个通道。
		this.emit(ipcChannels.agentsState, this.list());
		this.emit(ipcChannels.agentsRuntimeState, { agentId, state: this.buildRuntimeState(runtime) });
	}

	/** 节流 flush:流式 chunk 80ms 合并一次;force 立即全量(session 结算)。 */
	private scheduleFlush(runtime: AcpAgentRuntime): void {
		if (runtime.status === "closed" || this.runtimes.get(runtime.tab.id) !== runtime) return;
		if (runtime.flushTimer) {
			runtime.flushPending = true;
			return;
		}
		runtime.flushTimer = setTimeout(() => {
			runtime.flushTimer = null;
			const pending = runtime.flushPending;
			runtime.flushPending = false;
			this.flushMessages(runtime, !pending);
			if (pending) this.scheduleFlush(runtime);
		}, FLUSH_THROTTLE_MS);
		runtime.flushTimer.unref?.();
	}

	private flushMessages(runtime: AcpAgentRuntime, force: boolean): void {
		if (runtime.status === "closed" || this.runtimes.get(runtime.tab.id) !== runtime) return;
		if (force && runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			deckSessionId: runtime.tab.deckSessionId,
			messages: runtime.projection.messages,
			totalLength: runtime.projection.messages.length,
		});
		// 内存快照：stop/升级强杀后 runtime 删除，重入会话时 readMessagesByAcpSessionId
		// 用它避免时间线空白；激活后 session/load 重放会覆盖为完整历史。
		if (runtime.acpSessionId) {
			this.messageSnapshots.set(runtime.acpSessionId, runtime.projection.messages.slice(-MESSAGE_SNAPSHOT_LIMIT));
		}
	}

	/** 连接关闭/stop 时撤销全部审批；RPC 回包与 timer 清理由权限 owner 配对。 */
	private failPendingPermissions(runtime: AcpAgentRuntime): void {
		runtime.permissions.cancelAll();
	}

	/** 清回合辅助定时器（abort 升级宽限/stall 看门狗）；回合结算、stop、连接死亡共用。 */
	private clearTurnTimers(runtime: AcpAgentRuntime): void {
		this.clearAbortEscalation(runtime);
		this.clearStallWatchdog(runtime);
	}

	private clearAbortEscalation(runtime: AcpAgentRuntime): void {
		if (runtime.abortEscalateTimer) {
			clearTimeout(runtime.abortEscalateTimer);
			runtime.abortEscalateTimer = null;
		}
	}

	private clearStallWatchdog(runtime: AcpAgentRuntime): void {
		if (runtime.stallTimer) {
			clearInterval(runtime.stallTimer);
			runtime.stallTimer = null;
		}
	}

	/**
	 * abort 升级强杀出口：标记原因后走 stop() 同一路径（杀进程 → conn.close →
	 * 在途 session/prompt 被拒 → sendPrompt catch 定向结算）。
	 * cancelling 同步置位：强杀语义等价用户取消，不回滚用户消息。
	 */
	private forceStopRuntime(runtime: AcpAgentRuntime, reason: "abort_repeat" | "abort_no_response" | "stall"): void {
		if (this.runtimes.get(runtime.tab.id) !== runtime) return;
		this.clearTurnTimers(runtime);
		runtime.cancelling = true;
		runtime.escalatedStop = reason;
		this.deps.logger?.warn("acp", `[${runtime.tool.name}] force-stopping wedged agent (${reason})`, { agentId: runtime.tab.id, acpSessionId: runtime.acpSessionId });
		void this.stop(runtime.tab.id);
	}

	/** armed abort 升级：宽限内回合自行结算则 clearTurnTimers 取消；超时仍未结算强杀。 */
	private scheduleAbortEscalation(runtime: AcpAgentRuntime, reason: "abort_no_response" | "stall"): void {
		if (runtime.abortEscalateTimer || !runtime.turnActive) return;
		runtime.abortEscalateTimer = setTimeout(() => {
			runtime.abortEscalateTimer = null;
			if (this.runtimes.get(runtime.tab.id) !== runtime || !runtime.turnActive) return;
			this.forceStopRuntime(runtime, reason);
		}, this.deps.abortEscalationMs ?? ABORT_ESCALATION_MS);
		runtime.abortEscalateTimer.unref?.();
	}

	/**
	 * 回合 stall 看门狗：派发时布防，interval 检查 turnActive 期间是否长时间无任何
	 * session/update。全静默超阈值 → 先补发 cancel（agent 可能只是模型侧卡住，还活着），
	 * 再经 abort 升级宽限强杀——两级都由 forceStopRuntime 收口。
	 * 挂起审批不算静默：那是 agent 合法等待用户输入。
	 */
	private armStallWatchdog(runtime: AcpAgentRuntime): void {
		this.clearStallWatchdog(runtime);
		runtime.lastUpdateAt = Date.now();
		const timeoutMs = this.deps.promptStallTimeoutMs ?? PROMPT_STALL_TIMEOUT_MS;
		const intervalMs = Math.max(50, Math.min(5_000, Math.floor(timeoutMs / 3)));
		runtime.stallTimer = setInterval(() => {
			if (this.runtimes.get(runtime.tab.id) !== runtime || !runtime.turnActive) {
				this.clearStallWatchdog(runtime);
				return;
			}
			if (runtime.permissions.hasPending()) return;
			if (Date.now() - runtime.lastUpdateAt < timeoutMs) return;
			this.clearStallWatchdog(runtime);
			runtime.cancelling = true;
			runtime.cancelReason = "stall";
			runtime.permissions.cancelAll();
			try {
				runtime.conn?.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "stall" });
			} catch {
				// 连接已死:closed handler 会结算,这里不再补刀。
			}
			this.scheduleAbortEscalation(runtime, "stall");
		}, intervalMs);
		runtime.stallTimer.unref?.();
	}

	private killProcess(runtime: AcpAgentRuntime): void {
		if (runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.clearTurnTimers(runtime);
		runtime.conn?.close();
		const proc = runtime.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		runtime.proc = null;
		// Windows 下 spawn 常经 cmd.exe 垫片（.cmd shim），proc.kill() 只杀垫片进程，
		// CLI 孙进程成为孤儿（opencode 实测残留）；taskkill /T 按进程树强杀。
		// spawn 失败（taskkill 缺失等）兑底 proc.kill()——必须挂 error 监听（AGENTS 安全约束）。
		if (process.platform === "win32" && typeof proc.pid === "number") {
			try {
				const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
				killer.on("error", () => {
					try {
						proc.kill();
					} catch {}
				});
			} catch {
				try {
					proc.kill();
				} catch {}
			}
			return;
		}
		proc.kill();
	}
}

export { AcpRpcError, ACP_ERROR_CODE };
