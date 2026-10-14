/**
 * 会话运行时绑定网关 —— 主进程内部模块（IM 桥接、自动化等）与 pi 会话链路之间的唯一接口。
 *
 * 原先这个接口内联在 FeishuBridge 里。微信桥接成为第二个消费者后抽出来：桥接域只该
 * 依赖「契约」而不是「另一个桥接域」，否则加第三条通道就要照抄一遍、改动一处忘一处。
 * 实现仍在 main/index.ts 装配处（那里同时握着 sessionCatalog / sessionRuntimeCoordinator /
 * AgentManager），本模块只有类型，没有运行时依赖。
 */

import type { AgentRuntimeState, AgentTab, AvailableModel, ImageContent, SessionChannel } from "../../shared/types";

export interface SessionRuntimeBindingGateway {
	ensureSession(input: {
		projectId: string;
		title: string;
		existingSessionId?: string;
		sessionPath?: string;
		/**
		 * 外部连接渠道（微信/飞书桥建的会话）：落库后侧栏显示渠道标志。
		 */
		channel?: SessionChannel;
		/**
		 * 开放自动命名：会话标题不归 IM 桥所有，等 pi 侧自动命名（扩展模型标题）来领。
		 * 缺省（false）= 桥给的标题是权威名（titleOrigin: "manual"），自动命名不得覆盖。
		 */
		autoTitle?: boolean;
	}): Promise<{ sessionId: string }>;
	activateRuntime(sessionId: string): Promise<AgentTab>;
	bindRuntime(input: { projectId: string; agent: AgentTab; existingSessionId?: string }): Promise<{ sessionId: string }>;
	sendPrompt(input: { sessionId: string; message: string; agentMessage?: string; images?: ImageContent[] }): Promise<void>;
	abortRuntime(sessionId: string): Promise<void>;
	listRuntimeModels(sessionId: string): Promise<AvailableModel[]>;
	getRuntimeState(sessionId: string): Promise<AgentRuntimeState | undefined>;
	setRuntimeModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	/** 切会话思考档位（微信等 IM 通道的 run 一律关思考）。 */
	setRuntimeThinking(sessionId: string, level: string): Promise<void>;
	/** 把 ask/confirm 等扩展 UI 的答案写回 pi（与桌面端弹窗回答同一条链路）。 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; confirmed?: boolean; cancelled?: boolean }): void;
}
