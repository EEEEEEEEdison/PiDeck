/**
 * WeChatBridge — 微信 iLink（ClawBot）私聊桥接。
 *
 * 与 FeishuBridge 的关系：结构同构（IM 消息 → 稳定 pi 会话 → 结果回信），但有四处
 * 必须重写的差异，抄飞书的代码在微信上会直接坏掉：
 *
 * 1. **收信方向反了**：飞书是服务端 WebSocket 推给我们，微信是我们出站长轮询
 *    getupdates（实测每轮约 18s）。所以有游标持久化、退避重试、会话失效暂停。
 * 2. **不能主动推送**：回信必须带该条用户消息的 context_token，所以「先开口」是
 *    硬约束——开机问候、定时提醒、异步完成的兜底通知在微信上全都不存在。
 * 3. **只有纯文本**：没有卡片/按钮/Markdown/附件。飞书的 CardStream/AskCard/
 *    rich-text 在微信侧零复用价值，这里只用 weChatText 做 Markdown 降级与切分。
 * 4. **1:1 单账号**：一个微信号绑一个 Bot，没有群聊、没有多 Bot 路由；鉴权靠
 *    「只响应扫码那个 ilink_user_id」（协议自己不校验，必须我们兜住）。
 *
 * 会话身份仍是 session-first：binding.sessionId 是跨重启稳定的身份，agentId 只是
 * 当前 runtime 句柄，句柄失效就重新激活同一个 sessionId，而不是新建会话。
 */

import type { AgentTab, WeChatBridgeStatus, WeChatChatBinding } from "../../shared/types";
import { IlinkClient, IlinkError, type IlinkLogFn } from "./IlinkClient";
import { ILINK_CHANNEL_VERSION, MESSAGE_TYPE_USER, POLL_RETRY_FAST_MS, POLL_RETRY_SLOW_AFTER, POLL_RETRY_SLOW_MS, extractMessageText, hasUnsupportedItem, type IlinkMessage, type IlinkSession } from "./ilinkProtocol";
import type { SessionRuntimeBindingGateway } from "../sessions/sessionRuntimeBinding";
import type { AgentManager } from "../pi/AgentManager";
import { getAccount, getBinding, getDecryptedBotToken, getCursor, getPublicAccount, isAllowedUser, loadBindings, markNeedsRelogin, removeBinding, removeBindingsBySessionId, setCursor, upsertBinding } from "./WeChatConfig";
import { normalizeWeChatLocale, weChatLanguage, wechatT, type WeChatLocale, type WeChatTranslationKey } from "./WeChatI18n";
import { pickLatestAssistantText, prepareOutgoingText, splitForWeChat } from "./weChatText";

export type WeChatBridgeDeps = {
	agentManager: AgentManager;
	/** 返回当前可用项目；未配置时桥接拒绝建会话并提示用户。 */
	getProjects: () => Array<{ id: string; name: string }>;
	runtimeBindings: SessionRuntimeBindingGateway;
	/** 当前界面语言，决定回信文案。每次调用都重新取，用户切语言后无需重连。 */
	getLocale: () => string | undefined;
	/**
	 * 自报身份（base_info.bot_agent）。默认 `PiDeck`，装配处应传 `PiDeck/<version>`。
	 * **绝不冒充 OpenClaw**：实测服务端不据此鉴权，冒充只会让问题无法归因。
	 */
	botAgent?: string;
	/** 状态变化推给渲染层。 */
	onStatusChange?: (status: WeChatBridgeStatus) => void;
	/** 绑定变化推给渲染层（会话被删除/重建时要更新界面）。 */
	onBindingsChange?: () => void;
	logger?: IlinkLogFn;
};

/** 已处理消息 ID 的环形缓冲上限。微信侧重投概率低，但游标回退会重放，必须有幂等网。 */
const DEDUP_MAX = 200;
/** 单次 run 的上限。飞书同值：超时不是失败，而是转交「迟到投递」。 */
const AGENT_END_TIMEOUT_MS = 300_000;
/** agent_end 后等落盘/尾部 text_delta 收尾，避免回信缺最后一段（飞书同样 800ms）。 */
const RESULT_SETTLE_MS = 800;
/** 分片发送之间的间隔，避免一串长回复被服务端当刷屏。 */
const MULTI_CHUNK_GAP_MS = 400;
/** 迟到的 agent_end 超过这个时间就不再尝试回信（context_token 大概率已失效）。 */
const LATE_DELIVERY_MAX_MS = 60 * 60 * 1000;

export class WeChatBridge {
	private readonly deps: WeChatBridgeDeps;
	private client: IlinkClient | null = null;
	private status: WeChatBridgeStatus = { status: "disconnected", account: null, activeBindings: 0 };
	private stopping = false;
	private pollStarted = false;
	private unsubscribeEvents: (() => void) | null = null;

	/** 消息幂等：Set 提供 O(1) 查询，数组维持插入顺序用于淘汰。 */
	private readonly seenMessages: number[] = [];
	private readonly seenMessageSet = new Set<number>();

	/** 当前占着会话的 run（微信 1:1，最多一个）。非空时新消息只回「忙」。 */
	private activeRun: { chatId: string; contextToken: string; agentId?: string; startedAt: number } | null = null;
	/** runAgent 正在等的 agent_end 唤醒器。 */
	private readonly runWaiters = new Map<string, () => void>();
	/** 已收到 agent_end 的 agent（含迟到），用于消除「超时与事件同刻到达」的竞态。 */
	private readonly endedAgents = new Map<string, number>();
	/** 超时后仍挂着等待投递结果的 run：agent_end 迟到时补发。 */
	private readonly lateRuns = new Map<string, { chatId: string; contextToken: string; startedAt: number }>();

	constructor(deps: WeChatBridgeDeps) {
		this.deps = deps;
	}

	getStatus(): WeChatBridgeStatus {
		return this.status;
	}

	/** 启动前的最后一步校验都在这里：没账号/凭据解不开/服务端判失效，都不进轮询。 */
	async start(): Promise<void> {
		this.stopping = false;
		const account = getAccount();
		if (!account) {
			this.setStatus({ status: "disconnected", account: null, activeBindings: loadBindings().length, errorMessage: undefined });
			return;
		}
		const publicAccount = getPublicAccount();
		if (account.needsRelogin) {
			this.setStatus({ status: "error", account: publicAccount, activeBindings: loadBindings().length, errorMessage: "login-required" });
			return;
		}
		const token = getDecryptedBotToken();
		if (!token) {
			// 密文解不开（换了机器或系统凭据变了）。不能拿密文当 token 发出去，也不能
			// 静默当作已登录——直接告诉用户要重扫。
			this.setStatus({ status: "error", account: publicAccount, activeBindings: loadBindings().length, errorMessage: "credential-unavailable" });
			return;
		}

		this.setStatus({ status: "connecting", account: publicAccount, activeBindings: loadBindings().length, errorMessage: undefined });
		this.client = new IlinkClient({ baseUrl: account.baseUrl, channelVersion: ILINK_CHANNEL_VERSION, botAgent: this.deps.botAgent ?? "PiDeck", logger: this.deps.logger });
		this.attachAgentEvents();

		const session = this.buildSession();
		if (session) {
			// notifyStart 只是「告知服务端我开始服务」，失败不影响收发（实测非必需），
			// 所以只记日志不阻断——否则一次抖动就让用户以为连不上。
			try {
				await this.client.notifyStart(session);
			} catch (error) {
				this.deps.logger?.("warn", "notifyStart 失败，继续（非必需调用）", error instanceof Error ? error.message : String(error));
			}
		}

		this.setStatus({ status: "connected", account: publicAccount, activeBindings: loadBindings().length, connectedAt: Date.now() });
		if (!this.pollStarted) {
			this.pollStarted = true;
			void this.pollLoop();
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.pollStarted = false;
		this.detachAgentEvents();
		const client = this.client;
		this.client = null;
		const session = this.buildSession();
		if (client && session) {
			try {
				await client.notifyStop(session);
			} catch {
				// 停机路径的失败不值得打扰用户
			}
		}
		this.activeRun = null;
		this.runWaiters.clear();
		this.lateRuns.clear();
		this.endedAgents.clear();
		this.setStatus({ status: "disconnected", account: getPublicAccount(), activeBindings: loadBindings().length });
	}

	/** 会话被删除时清掉指向它的绑定，避免下次收信指向不存在的会话。 */
	removeBindingsForSession(sessionId: string): number {
		const removed = removeBindingsBySessionId(sessionId);
		if (removed > 0) {
			this.setStatus({ activeBindings: loadBindings().length });
			this.notifyBindingsChanged();
		}
		return removed;
	}

	/** 重新读盘并推状态（用户在设置里改工作区/模型、或重新扫码后调用）。 */
	refresh(): void {
		this.setStatus({ account: getPublicAccount(), activeBindings: loadBindings().length, errorMessage: undefined });
		this.notifyBindingsChanged();
	}

	// ===== 收信 =====

	private async pollLoop(): Promise<void> {
		let consecutiveFailures = 0;
		while (!this.stopping) {
			const session = this.buildSession();
			const client = this.client;
			if (!session || !client) return;

			try {
				const { msgs, cursor } = await client.getUpdates(session, session.cursor);
				consecutiveFailures = 0;
				if (cursor && cursor !== session.cursor) {
					setCursor(cursor);
					session.cursor = cursor;
				}
				for (const message of msgs) {
					this.handleIncoming(message);
				}
			} catch (error) {
				if (this.stopping) return;
				if (error instanceof IlinkError && error.kind === "session-expired") {
					// 官方要求：errcode -14 后必须暂停该账号所有调用 1 小时，否则触发风控。
					// 这里直接停轮询并置「需重新扫码」，把节奏交回用户，绝不自动重试。
					markNeedsRelogin();
					this.deps.logger?.("warn", "微信会话已失效（errcode -14），已暂停轮询并要求重新扫码");
					this.setStatus({ status: "error", account: getPublicAccount(), activeBindings: loadBindings().length, errorMessage: "login-required" });
					return;
				}
				consecutiveFailures += 1;
				const delay = consecutiveFailures >= POLL_RETRY_SLOW_AFTER ? POLL_RETRY_SLOW_MS : POLL_RETRY_FAST_MS;
				this.deps.logger?.("warn", `微信收信失败（第 ${consecutiveFailures} 次），${delay}ms 后重试`, error instanceof Error ? error.message : String(error));
				await sleep(delay);
			}
		}
	}

	/**
	 * 单条入站消息的同步分诊。
	 *
	 * 刻意保持**同步前置**：忙判定、命令判定、占位都在任何 await 之前完成，否则两条
	 * 相邻消息会在第一个 await 处交叉，双双进入 run 分支（JS 单线程只保证同步段原子）。
	 * run 本身 fire-and-forget，否则一次长任务会把长轮询卡住，连 /stop 都收不到。
	 */
	private handleIncoming(message: IlinkMessage): void {
		if (message.message_type !== MESSAGE_TYPE_USER) return;
		if (this.isDuplicate(message.message_id)) return;

		const chatId = message.from_user_id;
		const contextToken = message.context_token ?? "";
		if (message.group_id) {
			// 协议里群聊未文档化，能力元数据也只声明单聊。收到就礼貌拒绝，不假装支持。
			this.sendSafe(chatId, contextToken, this.t("text.group"));
			return;
		}
		if (!isAllowedUser(chatId)) {
			// 只有扫码那个微信号能与 Bot 对话。协议侧不拦，这里静默丢弃（不回错误，
			// 免得陌生人探测出「这个 Bot 认人」）。
			this.deps.logger?.("warn", "忽略非绑定用户的消息", chatId.slice(0, 8));
			return;
		}

		const text = extractMessageText(message.item_list ?? []).trim();
		const hasUnsupported = hasUnsupportedItem(message.item_list ?? []);
		if (!text) {
			if (hasUnsupported) this.sendSafe(chatId, contextToken, this.t("text.empty"));
			return;
		}

		this.setStatus({ lastMessageAt: Date.now() });

		if (text.startsWith("/")) {
			// 命令不占 run 槽：否则「正在跑长任务」时连 /stop 都发不进来。
			void this.handleCommand(chatId, contextToken, text).catch((error) => {
				this.deps.logger?.("error", "微信命令处理失败", error instanceof Error ? error.message : String(error));
			});
			return;
		}

		if (this.activeRun) {
			this.sendSafe(chatId, contextToken, this.t("run.busy"));
			return;
		}
		this.activeRun = { chatId, contextToken, startedAt: Date.now() };
		void this.runAgent(chatId, contextToken, text).catch((error) => {
			this.deps.logger?.("error", "微信任务执行失败", error instanceof Error ? error.message : String(error));
		});
	}

	private async runAgent(chatId: string, contextToken: string, text: string): Promise<void> {
		const binding = await this.ensureBinding(chatId);
		if (!binding) {
			this.activeRun = null;
			return;
		}
		const agentId = binding.agentId;
		if (!agentId) {
			this.activeRun = null;
			this.sendSafe(chatId, contextToken, this.t("session.restoreFailed"));
			return;
		}
		if (this.activeRun) this.activeRun.agentId = agentId;

		// 先注册唤醒器再提交 prompt：快速失败的 run（模型配置错、鉴权失败）会在
		// 提交窗口内就广播 agent_end，注册晚于事件会白等满 300s（飞书踩过同样的坑）。
		const timedOutPromise = this.waitForAgentEnd(agentId, AGENT_END_TIMEOUT_MS);

		try {
			await this.deps.runtimeBindings.sendPrompt({
				sessionId: binding.sessionId,
				message: text,
				agentMessage: this.buildAgentMessage(text),
			});
		} catch (error) {
			this.runWaiters.delete(agentId);
			this.endedAgents.delete(agentId);
			this.activeRun = null;
			const message = error instanceof Error ? error.message : String(error);
			this.sendSafe(chatId, contextToken, this.t("run.failed", { message }));
			return;
		}

		const timedOut = await timedOutPromise;
		if (timedOut) {
			// 超时不等于失败：run 还在跑，结果只能等 agent_end 迟到时补发。
			// 这里必须把等待交给 lateRuns，否则用户永远等不到回复且没有任何解释。
			this.lateRuns.set(agentId, { chatId, contextToken, startedAt: Date.now() });
			this.activeRun = null;
			this.sendSafe(chatId, contextToken, this.t("run.timeout"));
			return;
		}

		await sleep(RESULT_SETTLE_MS);
		this.activeRun = null;
		this.endedAgents.delete(agentId);
		await this.deliverResult(agentId, { chatId, contextToken, startedAt: Date.now() });
	}

	/** 读最近一条助手消息并回信。超时补发与正常投递共用这一条路径。 */
	private async deliverResult(agentId: string, target: { chatId: string; contextToken: string; startedAt: number }): Promise<void> {
		const messages = this.deps.agentManager.getMessages(agentId);
		const raw = pickLatestAssistantText(messages);
		if (!raw) {
			this.sendSafe(target.chatId, target.contextToken, this.t("run.noText"));
			return;
		}
		await this.sendSafe(target.chatId, target.contextToken, raw);
	}

	// ===== 命令 =====

	private async handleCommand(chatId: string, contextToken: string, text: string): Promise<void> {
		const [rawCommand, ...rest] = text.trim().split(/\s+/);
		const command = rawCommand.toLowerCase();
		const argument = rest.join(" ").trim();

		switch (command) {
			case "/help":
			case "/?":
				await this.sendSafe(chatId, contextToken, `${this.t("help.title")}\n${this.t("help.body")}\n\n${this.t("help.hint")}`);
				return;
			case "/new": {
				const binding = getBinding(chatId);
				if (binding) {
					// 只解绑不删会话：会话本身仍在桌面端，用户可能还想继续用。
					removeBinding(chatId);
					this.notifyBindingsChanged();
				}
				const created = await this.ensureBinding(chatId, { forceNew: true });
				if (created) {
					await this.sendSafe(chatId, contextToken, this.t("session.created", { id: created.sessionId.slice(0, 8) }));
				}
				return;
			}
			case "/stop": {
				const binding = getBinding(chatId);
				if (!binding) {
					await this.sendSafe(chatId, contextToken, this.t("run.nothing"));
					return;
				}
				await this.deps.runtimeBindings.abortRuntime(binding.sessionId);
				this.activeRun = null;
				if (binding.agentId) this.lateRuns.delete(binding.agentId);
				await this.sendSafe(chatId, contextToken, this.t("run.stopped"));
				return;
			}
			case "/status": {
				const binding = getBinding(chatId);
				if (!binding) {
					await this.sendSafe(chatId, contextToken, this.t("session.none"));
					return;
				}
				const state = await this.deps.runtimeBindings.getRuntimeState(binding.sessionId);
				const model = state?.modelName ?? state?.modelId ?? binding.modelId ?? "-";
				await this.sendSafe(
					chatId,
					contextToken,
					this.t("session.status", {
						id: binding.sessionId.slice(0, 8),
						workspace: binding.workspaceId || this.projectName(binding.workspaceId),
						model,
						state: this.activeRun ? "running" : "idle",
					}),
				);
				return;
			}
			case "/model": {
				await this.handleModelCommand(chatId, contextToken, argument);
				return;
			}
			default:
				await this.sendSafe(chatId, contextToken, `${this.t("help.title")}\n${this.t("help.body")}`);
		}
	}

	private async handleModelCommand(chatId: string, contextToken: string, argument: string): Promise<void> {
		const binding = getBinding(chatId);
		if (!binding) {
			await this.sendSafe(chatId, contextToken, this.t("session.none"));
			return;
		}
		const models = await this.deps.runtimeBindings.listRuntimeModels(binding.sessionId);
		if (models.length === 0) {
			await this.sendSafe(chatId, contextToken, this.t("model.empty"));
			return;
		}
		if (!argument) {
			const state = await this.deps.runtimeBindings.getRuntimeState(binding.sessionId);
			const current = state?.modelName ?? state?.modelId ?? binding.modelId ?? "-";
			// 模型可能上百个，列举要截断并说明截断了——静默截断会让人以为列表就是全部。
			const listed = models.slice(0, 30).map((model) => `- ${model.provider}/${model.id}`);
			if (models.length > listed.length) listed.push(`… +${models.length - listed.length}`);
			await this.sendSafe(chatId, contextToken, `${this.t("model.current", { model: current })}\n${listed.join("\n")}\n\n${this.t("model.usage")}`);
			return;
		}
		const target = argument.toLowerCase();
		const match = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === target) ?? models.find((model) => model.id.toLowerCase() === target) ?? models.find((model) => model.name?.toLowerCase() === target);
		if (!match) {
			await this.sendSafe(chatId, contextToken, this.t("model.invalid", { model: argument }));
			return;
		}
		await this.deps.runtimeBindings.setRuntimeModel(binding.sessionId, match.provider, match.id);
		upsertBinding({ ...binding, modelId: match.id });
		await this.sendSafe(chatId, contextToken, this.t("model.switched", { model: `${match.provider}/${match.id}` }));
	}

	// ===== 会话绑定 =====

	/**
	 * 取得可用的 agent 句柄。已有绑定时校验句柄仍然有效（网关会核对 sessionId 身份），
	 * 失败就重新激活同一个 sessionId；只有 /new 才真的新建会话。
	 */
	private async ensureBinding(chatId: string, options?: { forceNew?: boolean }): Promise<WeChatChatBinding | undefined> {
		const existing = options?.forceNew ? undefined : getBinding(chatId);
		if (existing) {
			const agentId = await this.authorizeRuntimeAgent(existing);
			if (agentId) return { ...existing, agentId };
		}
		return this.activateBinding(existing, chatId);
	}

	/** 句柄复用必须同时满足「进程还活着」与「网关认可同一个稳定 sessionId」。 */
	private async authorizeRuntimeAgent(binding: WeChatChatBinding): Promise<string | undefined> {
		if (!binding.agentId) return undefined;
		const tab = this.deps.agentManager.list().find((candidate) => candidate.id === binding.agentId);
		if (!tab || tab.status === "error" || tab.status === "closed") {
			upsertBinding({ ...binding, agentId: undefined });
			return undefined;
		}
		try {
			const runtimeBinding = await this.deps.runtimeBindings.bindRuntime({ projectId: tab.projectId, agent: tab, existingSessionId: binding.sessionId });
			if (runtimeBinding.sessionId !== binding.sessionId) {
				throw new Error(`runtime gateway returned a different session: ${runtimeBinding.sessionId}`);
			}
			return tab.id;
		} catch (error) {
			this.deps.logger?.("warn", "微信绑定句柄校验失败，重新激活会话", error instanceof Error ? error.message : String(error));
			upsertBinding({ ...binding, agentId: undefined });
			return undefined;
		}
	}

	private async activateBinding(existing: WeChatChatBinding | undefined, chatId: string): Promise<WeChatChatBinding | undefined> {
		const projects = this.deps.getProjects();
		if (projects.length === 0) {
			this.sendSafe(chatId, this.currentContextToken(chatId), this.t("project.required"));
			return undefined;
		}
		const workspaceId = existing?.workspaceId || projects[0].id;
		const projectId = projects.some((project) => project.id === workspaceId) ? workspaceId : projects[0].id;
		const title = existing ? "微信对话" : `微信 ${chatId.slice(-4)}`;

		try {
			let session = await this.deps.runtimeBindings.ensureSession({
				projectId,
				title,
				existingSessionId: existing?.sessionId,
				sessionPath: existing?.sessionPath,
			});
			let tab: AgentTab;
			try {
				tab = await this.deps.runtimeBindings.activateRuntime(session.sessionId);
			} catch (error) {
				// 历史 sessionPath 恢复失败（文件被删/格式变化）时退化为新会话，
				// 而不是让这个 chat 永久卡在错误上。
				if (!existing?.sessionPath) throw error;
				this.deps.logger?.("warn", "微信会话恢复失败，改新建", error instanceof Error ? error.message : String(error));
				session = await this.deps.runtimeBindings.ensureSession({ projectId, title: `微信 ${chatId.slice(-4)}` });
				tab = await this.deps.runtimeBindings.activateRuntime(session.sessionId);
			}
			const binding: WeChatChatBinding = {
				chatId,
				userId: chatId,
				sessionId: session.sessionId,
				sessionPath: tab.sessionPath,
				workspaceId: projectId,
				modelId: existing?.modelId,
				createdAt: existing?.createdAt ?? Date.now(),
				agentId: tab.id,
			};
			upsertBinding(binding);
			this.setStatus({ activeBindings: loadBindings().length });
			this.notifyBindingsChanged();
			return binding;
		} catch (error) {
			this.deps.logger?.("error", "微信会话激活失败", error instanceof Error ? error.message : String(error));
			this.sendSafe(chatId, this.currentContextToken(chatId), this.t("session.createFailed"));
			return undefined;
		}
	}

	// ===== agent 事件 =====

	private attachAgentEvents(): void {
		if (this.unsubscribeEvents) return;
		this.unsubscribeEvents = this.deps.agentManager.addLocalEventListener((agentId, event) => this.handleAgentEvent(agentId, event));
	}

	private detachAgentEvents(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = null;
	}

	private handleAgentEvent(agentId: string, event: unknown): void {
		if (!event || typeof event !== "object") return;
		if ((event as Record<string, unknown>).type !== "agent_end") return;
		this.endedAgents.set(agentId, Date.now());

		const waiter = this.runWaiters.get(agentId);
		if (waiter) {
			this.runWaiters.delete(agentId);
			waiter();
			return;
		}
		const late = this.lateRuns.get(agentId);
		if (late) {
			this.lateRuns.delete(agentId);
			this.endedAgents.delete(agentId);
			if (Date.now() - late.startedAt > LATE_DELIVERY_MAX_MS) {
				this.deps.logger?.("warn", "微信迟到结果已超出投递窗口，放弃回信");
				return;
			}
			void sleep(RESULT_SETTLE_MS)
				.then(() => this.deliverResult(agentId, late))
				.catch((error) => this.deps.logger?.("warn", "微信迟到结果回信失败", error instanceof Error ? error.message : String(error)));
		}
	}

	/** 返回 true 表示等超时了（run 仍在进行），false 表示已收到 agent_end。 */
	private waitForAgentEnd(agentId: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.runWaiters.delete(agentId);
				// 事件与超时同刻到达时，endedAgents 已经记下了，不能误判为超时。
				resolve(!this.endedAgents.has(agentId));
			}, timeoutMs);
			this.runWaiters.set(agentId, () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
	}

	// ===== 发送 =====

	/** 出站统一入口：Markdown 降级 → 分片 → 逐条发。失败不抛（回信失败不该打断会话）。 */
	private async sendSafe(chatId: string, contextToken: string, text: string): Promise<void> {
		const client = this.client;
		const session = this.buildSession();
		if (!client || !session) return;
		if (!contextToken) {
			// 没有 context_token 就无法回信（协议要求）。这只会出现在「桌面端主动发」的
			// 场景，微信不支持，直接放弃而不是发一条注定失败的请求。
			this.deps.logger?.("warn", "缺 context_token，跳过发送");
			return;
		}
		const chunks = splitForWeChat(prepareOutgoingText(text));
		if (chunks.length === 0) return;
		for (let index = 0; index < chunks.length; index += 1) {
			try {
				await client.sendText(session, { toUserId: chatId, contextToken, text: chunks[index] });
			} catch (error) {
				this.deps.logger?.("warn", "微信发送失败", error instanceof Error ? error.message : String(error));
				this.setStatus({ errorMessage: "send-failed" });
				return;
			}
			if (index < chunks.length - 1) await sleep(MULTI_CHUNK_GAP_MS);
		}
	}

	/** 让 Agent 知道自己在微信通道上，避免它去调微信 API 或输出 Markdown 表格。 */
	private buildAgentMessage(text: string): string {
		const instructions = [
			"当前会话已连接微信（iLink 私聊通道）。微信只支持纯文本：不要输出 Markdown 表格、代码围栏、图片或链接语法，表格请改成分行列表，PiDeck 会在回复前做纯文本降级。",
			"不要调用任何微信/IM 发送接口、CLI 或工具来发消息，也不要询问 chat_id：你的最终回答会自动回复给微信用户。",
			"该通道不支持发送文件、图片与引用消息；需要用户手动取用文件时，直接给出绝对路径。",
			"微信通道不能主动推送消息，用户只有发消息时才能收到回复。",
			`请用${weChatLanguage(this.locale())}回答。`,
		].join("\n");
		return text ? `${instructions}\n\n${text}` : instructions;
	}

	// ===== 辅助 =====

	private buildSession(): IlinkSession | null {
		const account = getAccount();
		if (!account) return null;
		const token = getDecryptedBotToken();
		if (!token) return null;
		return {
			botToken: token,
			baseUrl: account.baseUrl,
			ilinkBotId: account.ilinkBotId,
			ilinkUserId: account.ilinkUserId,
			cursor: getCursor(),
		};
	}

	/**
	 * 只在需要回「忙/失败」提示时用作兜底。真正处理消息时用的是消息自带的 token
	 * （这里没有别的来源，微信不支持凭空的会话引用）。
	 */
	private currentContextToken(_chatId: string): string {
		return this.activeRun?.contextToken ?? "";
	}

	private locale(): WeChatLocale {
		return normalizeWeChatLocale(this.deps.getLocale());
	}

	private t(key: WeChatTranslationKey, params?: Record<string, string | number>): string {
		return wechatT(this.locale(), key, params);
	}

	private projectName(projectId: string): string {
		return this.deps.getProjects().find((project) => project.id === projectId)?.name ?? projectId;
	}

	private isDuplicate(messageId: number): boolean {
		if (this.seenMessageSet.has(messageId)) return true;
		this.seenMessageSet.add(messageId);
		this.seenMessages.push(messageId);
		if (this.seenMessages.length > DEDUP_MAX) {
			const evicted = this.seenMessages.shift();
			if (evicted !== undefined) this.seenMessageSet.delete(evicted);
		}
		return false;
	}

	private setStatus(patch: Partial<WeChatBridgeStatus>): void {
		this.status = { ...this.status, ...patch };
		try {
			this.deps.onStatusChange?.(this.status);
		} catch (error) {
			this.deps.logger?.("warn", "微信状态回调抛错", error instanceof Error ? error.message : String(error));
		}
	}

	private notifyBindingsChanged(): void {
		try {
			this.deps.onBindingsChange?.();
		} catch (error) {
			this.deps.logger?.("warn", "微信绑定回调抛错", error instanceof Error ? error.message : String(error));
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
