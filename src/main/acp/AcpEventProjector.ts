/**
 * ACP session/update → PiDeck ChatMessage / TodoItem 投影器(纯函数)。
 *
 * 与 dshEventProjector 同一职责:把 agent 事件流折叠成渲染层时间线消息与
 * runtime 状态。ACP 的流是 JSON-RPC 通知(session/update),无 seq——顺序由
 * stdio 管道天然保序,投影按到达顺序追加。
 *
 * 投影规则(与渲染层既有卡片契约对齐,见 dshEventProjector 的 meta 约定):
 * - user_message_chunk:user 消息回显(渲染层对 acp 后端不本地 append,靠投影回显,
 *   与 DSH 同策略——避免发送方与 agent 回显双条)。agent 不回显时由 appendAcpUserPrompt
 *   在 prompt 派发处本地落条目(见该函数:ACP 规范里回显是 agent 的可选行为)。
 * - agent_message_chunk / agent_thought_chunk:聚合进「当前回合」的一条 assistant
 *   流式消息;thoughtChunk 写 thinking 字段(渲染层思考折叠块)。
 * - tool_call:role="tool" 卡片消息,meta.status 驱动旋转动画;同一 toolCallId 的
 *   in_progress/completed/failed 更新原卡片(按 callId 精确匹配,非最后一条)。
 * - plan:整表 last-wins 归一化为 TodoItem[](AgentRuntimeState.todos 同源)。
 * - available_commands_update:listCommands 数据源(PiCommand[])。
 * - unknown update:忽略(前向兼容,规范允许新增 update 类型)。
 */
import type { AcpSessionUpdate, AcpToolCallUpdate } from "./acpProtocol";
import { fallbackSessionTitle } from "../dsh/dshSessionTitleFold";
import type { TodoItem } from "../../shared/types/todo";
import type { ChatMessage } from "../../shared/types/session";
import type { PiCommand } from "../../shared/types/app";

/** 工具卡展开区截断上限(对齐 dshEventProjector 的 TOOL_RESULT_MAX_CHARS 契约)。 */
export const ACP_TOOL_RESULT_MAX_CHARS = 2000;

export type AcpProjectionState = {
	messages: ChatMessage[];
	/** 当前回合流式 assistant 消息下标(messages 内);无活动回合为 undefined。 */
	activeAssistantIndex?: number;
	/** toolCallId → messages 下标,收口更新按 callId 精确回写。 */
	toolCardIndex: Map<string, number>;
	todos?: TodoItem[];
	commands: PiCommand[];
	/** 最近一次 session_info_update 的标题(供 catalog 回写)。 */
	title?: string;
	/**
	 * 本地 prompt 回显待去重队列（文本 + agent 已回显的字符数）。
	 * 见 appendAcpUserPrompt：agent 回显 user_message_chunk 时按前缀消费，
	 * 避免同一条用户消息在时间线上出现两次。
	 */
	localUserEchoes?: Array<{ text: string; echoed: number }>;
	/**
	 * 投影侧信道：本次 update 触及的 messages 下标（无消息变更时为 undefined）。
	 *
	 * 用途是图片物化（AcpAgentManager.materializeTouchedImages）：ACP 的图片以 base64 随 chunk
	 * 抵达，只有知道「这次更新动了哪条消息」才能只对该条落盘、避免每轮全量扫描。
	 * 语义是「本次 update」而非累计——消费者在每次投影后立刻读取。
	 */
	lastTouched?: number[];
	/** 任意 update 到达过(load 重放也置位)。 */
	replayed: boolean;
};

export function initialAcpProjection(): AcpProjectionState {
	return {
		messages: [],
		toolCardIndex: new Map(),
		commands: [],
		replayed: false,
	};
}

let messageCounter = 0;
function nextMessageId(): string {
	messageCounter += 1;
	return `acp-${Date.now().toString(36)}-${messageCounter.toString(36)}`;
}

/** 工具卡内容块 → 展示文本:文本直拼;diff/terminal/图片等特殊块给占位描述。 */
function toolContentText(update: AcpToolCallUpdate): { text: string; fullText?: string } {
	let text = "";
	let special = "";
	for (const block of update.content ?? []) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text;
		} else if (block.type === "resource_link") {
			special += `${(block as { name?: string }).name ?? (block as { uri?: string }).uri ?? "resource"}\n`;
		} else if (block.type === "image") {
			special += "[image]\n";
		} else if (block.type === "diff") {
			const diff = block as { path?: string };
			special += `[diff ${diff.path ?? ""}]\n`;
		} else if (block.type === "terminal") {
			special += "[terminal]\n";
		}
	}
	const combined = (text + (special ? `\n${special.trim()}` : "")).trim();
	if (combined.length <= ACP_TOOL_RESULT_MAX_CHARS) return { text: combined };
	return { text: combined.slice(0, ACP_TOOL_RESULT_MAX_CHARS), fullText: combined };
}

/** tool_call kind → 工具卡渲染形态:read 类对齐只读工具样式。 */
function toolDisplayKind(update: AcpToolCallUpdate): string {
	return update.kind === "read" ? "read" : "execute";
}

function toolStatus(status: AcpToolCallUpdate["status"]): "running" | "completed" | "failed" {
	if (status === "completed") return "completed";
	if (status === "failed") return "failed";
	return "running";
}

export function projectAcpSessionUpdate(state: AcpProjectionState, update: AcpSessionUpdate, agentId: string): AcpProjectionState {
	const next: AcpProjectionState = { ...state, messages: state.messages, toolCardIndex: state.toolCardIndex, commands: state.commands, replayed: true, activeAssistantIndex: state.activeAssistantIndex, lastTouched: undefined };
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			// 一次一个 content block:文本块拼 text;图片块进 images(回显路径)。
			const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string } | undefined;
			if (!content || typeof content !== "object") return state;
			if (content.type === "text" && typeof content.text === "string" && content.text) {
				const chunkText = content.text;
				// 本地回显去重：prompt 派发时 appendAcpUserPrompt 已把用户消息写进投影，
				// agent 再把同文回显一遍就会双条。按「前缀」匹配而不是整串相等——
				// 有的 agent 把用户消息也按 chunk 分片流式回显。
				const pending = state.localUserEchoes ?? [];
				const echoIndex = pending.findIndex((entry) => entry.text.slice(entry.echoed).startsWith(chunkText));
				if (echoIndex >= 0) {
					const entry = pending[echoIndex];
					const echoed = entry.echoed + chunkText.length;
					// 回显完就出队；未回完保留进度，后续分片继续消费。
					next.localUserEchoes = echoed >= entry.text.length ? [...pending.slice(0, echoIndex), ...pending.slice(echoIndex + 1)] : [...pending.slice(0, echoIndex), { text: entry.text, echoed }, ...pending.slice(echoIndex + 1)];
					return next;
				}
				// 与本地条目都不同文：是 agent 自己的用户侧消息(如注入的上下文)，照常追加；
				// 本地未回显条目不再期待回显（否则后续同文回显会被误吞），只留下回显到一半的。
				next.localUserEchoes = pending.filter((entry) => entry.echoed > 0);
				next.messages = [...state.messages, { id: nextMessageId(), agentId, role: "user", text: chunkText, timestamp: Date.now() }];
				next.lastTouched = [state.messages.length];
				return next;
			}
			if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
				next.messages = [
					...state.messages,
					{
						id: nextMessageId(),
						agentId,
						role: "user",
						text: "",
						images: [{ type: "image", mimeType: content.mimeType, data: content.data }],
						timestamp: Date.now(),
					},
				];
				next.lastTouched = [state.messages.length];
				return next;
			}
			return state;
		}
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const isThought = update.sessionUpdate === "agent_thought_chunk";
			const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string } | undefined;
			const text = typeof content?.text === "string" ? content.text : "";
			// 思考流是纯文本(图块按契约丢弃)；助手正文允许图块——生图结果只有图没有字，
			// 按 text 为空就丢弃会让生成结果整条消失，所以「无文本但有图」也要建消息／并入。
			const image = !isThought && content?.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string" ? { type: "image" as const, mimeType: content.mimeType, data: content.data } : undefined;
			if (!text && !image) return state;
			const activeIndex = state.activeAssistantIndex;
			const active = activeIndex !== undefined ? state.messages[activeIndex] : undefined;
			if (active && active.role === "assistant" && activeIndex !== undefined) {
				const merged: ChatMessage = isThought ? { ...active, thinking: (active.thinking ?? "") + text, thinkingStartedAt: active.thinkingStartedAt ?? active.timestamp } : { ...active, text: active.text + text, ...(image ? { images: [...(active.images ?? []), image] } : {}) };
				next.messages = [...state.messages];
				next.messages[activeIndex] = merged;
				next.lastTouched = [activeIndex];
			} else {
				const created: ChatMessage = {
					id: nextMessageId(),
					agentId,
					role: "assistant",
					text: isThought ? "" : text,
					...(image ? { images: [image] } : {}),
					...(isThought ? { thinking: text, thinkingStartedAt: Date.now() } : {}),
					timestamp: Date.now(),
					stopReason: "pending",
				};
				next.messages = [...state.messages, created];
				const createdIndex = next.messages.length - 1;
				next.activeAssistantIndex = createdIndex;
				next.lastTouched = [createdIndex];
			}
			return next;
		}
		case "tool_call": {
			// switch 判别被 fallback 宽类型(sessionUpdate: string)击穿，显式收窄。
			const toolUpdate = update as AcpToolCallUpdate;
			const cardIndex = state.toolCardIndex.get(toolUpdate.toolCallId);
			if (cardIndex !== undefined && state.messages[cardIndex]?.role === "tool") {
				const existing = state.messages[cardIndex];
				const contentText = toolContentText(toolUpdate);
				next.messages = [...state.messages];
				next.messages[cardIndex] = {
					...existing,
					meta: {
						...(existing.meta ?? {}),
						toolName: toolUpdate.title,
						status: toolStatus(toolUpdate.status),
						...(toolUpdate.kind ? { kind: toolDisplayKind(toolUpdate) } : {}),
						...(contentText.text ? { fullText: contentText.fullText ?? contentText.text, truncated: contentText.fullText !== undefined } : {}),
						...(toolUpdate.locations?.length ? { locations: toolUpdate.locations } : {}),
					},
				};
				next.lastTouched = [cardIndex];
			} else {
				const contentText = toolContentText(toolUpdate);
				const card: ChatMessage = {
					id: nextMessageId(),
					agentId,
					role: "tool",
					text: toolUpdate.title,
					timestamp: Date.now(),
					meta: {
						toolCallId: toolUpdate.toolCallId,
						toolName: toolUpdate.title,
						status: toolStatus(toolUpdate.status),
						...(toolUpdate.kind ? { kind: toolDisplayKind(toolUpdate) } : {}),
						...(contentText.text ? { fullText: contentText.fullText ?? contentText.text, truncated: contentText.fullText !== undefined } : {}),
						...(toolUpdate.locations?.length ? { locations: toolUpdate.locations } : {}),
					},
				};
				next.messages = [...state.messages, card];
				next.toolCardIndex = new Map(state.toolCardIndex);
				const toolCardIndex = next.messages.length - 1;
				next.toolCardIndex.set(toolUpdate.toolCallId, toolCardIndex);
				next.lastTouched = [toolCardIndex];
			}
			return next;
		}
		case "plan": {
			const planUpdate = update as { plan?: Array<{ content?: unknown; status?: unknown }> };
			next.todos = (Array.isArray(planUpdate.plan) ? planUpdate.plan : []).map((entry) => ({
				content: typeof entry?.content === "string" ? entry.content : "",
				status: entry?.status === "in_progress" ? "in_progress" : entry?.status === "completed" ? "completed" : "pending",
			}));
			return next;
		}
		case "available_commands_update": {
			const commandsUpdate = update as { commands?: Array<{ name?: unknown; description?: unknown }> };
			next.commands = (Array.isArray(commandsUpdate.commands) ? commandsUpdate.commands : []).map((command) => ({
				name: typeof command?.name === "string" ? command.name : "",
				...(typeof command?.description === "string" && command.description ? { description: command.description } : {}),
				source: "acp",
			}));
			return next;
		}
		case "session_info_update": {
			const infoUpdate = update as { sessionTitle?: unknown };
			if (typeof infoUpdate.sessionTitle === "string" && infoUpdate.sessionTitle.trim()) next.title = infoUpdate.sessionTitle.trim();
			return next;
		}
		case "current_mode_update":
		case "config_option_update":
			// 首版不消费(无 mode/config UI);不报错,静默忽略。
			return state;
		default:
			// 未知 update 类型:规范允许前向扩展,忽略。
			return state;
	}
}

/** session/prompt 结算(stopReason 回填 + 活动流式消息收口)。 */
export function settleAcpTurn(state: AcpProjectionState, stopReason: "end_turn" | "cancelled" | "aborted" | "error"): AcpProjectionState {
	const active = state.activeAssistantIndex !== undefined ? state.messages[state.activeAssistantIndex] : undefined;
	if (!active || state.activeAssistantIndex === undefined) return { ...state, activeAssistantIndex: undefined };
	const reason = stopReason === "end_turn" ? "stop" : stopReason === "cancelled" || stopReason === "aborted" ? "aborted" : "error";
	const messages = [...state.messages];
	messages[state.activeAssistantIndex] = { ...active, stopReason: reason };
	return { ...state, messages, activeAssistantIndex: undefined };
}

/** user 消息内容构造:文本 + 图片块(SendPromptInput.images → AcpContentBlock[])。 */
export function acpPromptBlocks(text: string, images?: ReadonlyArray<{ type: string; mimeType?: string; data?: string }> | null): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text }];
	for (const image of images ?? []) {
		if (image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") {
			blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
		}
	}
	return blocks;
}

export function rollbackAcpUserPrompt(state: AcpProjectionState, index: number): AcpProjectionState {
	// 撤回条件：本次 prompt 落的条目仍是最后一条，且 agent 没有在回显中途
	// （有回显进度说明它已经收到 prompt，撤掉本地条目会与 agent 侧会话不一致）。
	if (index < 0 || state.messages.length !== index + 1) return state;
	if (state.messages[index]?.role !== "user") return state;
	const echoes = state.localUserEchoes ?? [];
	if (echoes.some((entry) => entry.echoed > 0)) return state;
	return { ...state, messages: state.messages.slice(0, index), localUserEchoes: echoes.slice(0, -1), lastTouched: undefined };
}

/**
 * 把用户发出的 prompt 写进投影（本地回显）+ 首条提示兜底标题。
 *
 * 为什么主进程要自己写：ACP 的 `user_message_chunk` 是 agent 的**可选**回显
 * （规范只说 agent 需要时把用户输入回放给 client），OpenCode 等实现根本不发，
 * 而 ACP 的 `agents:message` 是**全量替换**语义（渲染层缓存整段被覆盖），
 * 于是渲染层发出的乐观用户气泡会被第一次 flush 抹掉——表现为「只显示 AI 回复，
 * 用户消息不见了」。条目落在主进程侧，时间线（含渲染层、导出、重载）才与
 * agent 是否回显无关。
 *
 * 标题：ACP 会话没有本地文件，agent 只在自己愿意时发 `session_info_update`，
 * 因此首条 prompt 就按确定性规则兜底一个标题（与 DSH 的回退标题同一套截断规则，
 * 不另起第二套），agent 后续给出的标题仍会覆盖它（last-wins）。
 *
 * 调用方在派发失败且 agent 未产出任何内容时用 rollbackAcpUserPrompt 撤回本条。
 */
export function appendAcpUserPrompt(state: AcpProjectionState, text: string, images: ReadonlyArray<{ type: string; mimeType?: string; data?: string }> | null | undefined, agentId: string): AcpProjectionState {
	const imageBlocks: Array<{ type: "image"; mimeType: string; data: string }> = [];
	for (const image of images ?? []) {
		if (image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") imageBlocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
	}
	if (!text && imageBlocks.length === 0) return state;
	const message: ChatMessage = {
		id: nextMessageId(),
		agentId,
		role: "user",
		text,
		...(imageBlocks.length ? { images: imageBlocks } : {}),
		timestamp: Date.now(),
	};
	const title = state.title ?? (text ? fallbackSessionTitle(text) : "");
	return {
		...state,
		messages: [...state.messages, message],
		// 队列只保留「回显到一半」的条目 + 本条：agent 全程不回显时（OpenCode 等）
		// 不会每条 prompt 都留一个永不消费的条目。
		localUserEchoes: [...(state.localUserEchoes ?? []).filter((entry) => entry.echoed > 0), { text, echoed: 0 }],
		...(title ? { title } : {}),
		lastTouched: [state.messages.length],
		replayed: true,
	};
}
