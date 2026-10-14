import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 微信 iLink 桥接行为测试（WeChatBridge）。
 *
 * 桥接的价值全在「协议不管、我们必须自己兜住」的那几条：身份白名单（iLink 不校验
 * 消息来源）、幂等（游标回退会重放）、1:1 忙判定、context_token 回信约束，
 * 以及 errcode -14 必须停轮询而不是自动重试。这些都不是纯函数，只能靠带假传输层
 * 的行为测试钉住，所以这里用注入的 IlinkClient / WeChatConfig 真跑一遍收信链路。
 */

const load = createTsSandbox({});
const { MESSAGE_TYPE_USER } = load("src/main/wechat/ilinkProtocol.ts");

// normalizeModelChain 是纯函数，直接从真实 WeChatConfig 取：测试里再抄一份归一化逻辑，
// 迟早会和生产实现跑偏——而模型链的正确性恰恰靠它兜底（假配置模块只是状态替身，
// 整模块替换会把其它导出一并抹掉，漏掉它 bridge 会在建计划时直接抛）。
const realConfigSandbox = createTsSandbox({ stubs: { electron: { app: { getPath: () => "/tmp/pideck-wechat-test" }, safeStorage: { isEncryptionAvailable: () => false } } } });
const { normalizeModelChain } = realConfigSandbox("src/main/wechat/WeChatConfig.ts");

/** 轮询等待条件成立（真定时器：桥接里有 800ms 落盘收尾，不能靠微任务抢跑）。 */
async function waitFor(predicate, label, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** 假 IlinkClient：把 getUpdates 变成可编排的批次队列，记录所有出站发送。 */
function makeClientStub({ batches = [], failWith = null, failTypingWith = null } = {}) {
	const calls = { notifyStart: 0, notifyStop: 0, getUpdates: 0, getConfig: 0, typing: [], sent: [] };
	const queue = [...batches];
	let cursor = "";
	let errorToThrow = failWith;
	let typingError = failTypingWith;
	/** 队列空时挂起的长轮询唤醒器：push 时唤醒，避免用紧循环假装长轮询。 */
	let wakeup = null;

	class IlinkError extends Error {
		constructor(kind, message) {
			super(message);
			this.kind = kind;
			this.name = "IlinkError";
		}
	}

	class IlinkClient {
		constructor(options) {
			calls.options = options;
		}
		async notifyStart() {
			calls.notifyStart += 1;
		}
		async notifyStop() {
			calls.notifyStop += 1;
		}
		async getUpdates(session, sessionCursor) {
			calls.getUpdates += 1;
			for (;;) {
				if (errorToThrow) {
					const error = errorToThrow;
					errorToThrow = null;
					throw error;
				}
				if (queue.length > 0) {
					const batch = queue.shift();
					if (batch.cursor) cursor = batch.cursor;
					return { msgs: batch.msgs ?? [], cursor };
				}
				// 队列空了就挂起，等 push 唤醒：绝不能返回空批次（长轮询会变成紧循环，微任务风暴饿死测试定时器）。
				await new Promise((resolve) => {
					wakeup = resolve;
				});
			}
		}
		async getConfig() {
			calls.getConfig += 1;
			if (typingError) throw typingError;
			return { typing_ticket: "TICKET" };
		}
		async sendTyping(session, userId, ticket, status) {
			calls.typing.push({ userId, ticket, status });
			if (typingError) throw typingError;
		}
		async sendText(session, payload) {
			calls.sent.push(payload);
			return { message_id: 1 };
		}
	}

	return {
		IlinkClient,
		IlinkError,
		calls,
		push: (batch) => {
			queue.push(batch);
			const resolve = wakeup;
			wakeup = null;
			resolve?.();
		},
		failOnce: (error) => {
			errorToThrow = error;
		},
		error: (kind, message) => new IlinkError(kind, message),
	};
}

/** 假配置：桥接的读路径全部走这里，测试直接改 state。 */
function makeConfigStub({ account, token = "TOKEN", allowedUsers = [], bindings = [] } = {}) {
	const state = {
		account,
		token,
		allowed: new Set(allowedUsers),
		bindings: new Map(bindings.map((binding) => [binding.chatId, binding])),
		cursor: "",
		relogin: 0,
		saves: [],
	};
	const noop = () => 0;
	return {
		state,
		api: {
			getAccount: () => state.account,
			getPublicAccount: () => (state.account ? { ilinkBotId: state.account.ilinkBotId, ilinkUserId: state.account.ilinkUserId, displayName: state.account.displayName, baseUrl: state.account.baseUrl, loggedInAt: state.account.loggedInAt } : null),
			getDecryptedBotToken: () => state.token,
			isAllowedUser: (userId) => state.allowed.has(userId),
			getCursor: () => state.cursor,
			setCursor: (value) => {
				state.cursor = value;
			},
			loadBindings: () => [...state.bindings.values()],
			getBinding: (chatId) => state.bindings.get(chatId),
			upsertBinding: (binding) => {
				state.bindings.set(binding.chatId, binding);
				state.saves.push(binding);
			},
			removeBinding: (chatId) => {
				state.bindings.delete(chatId);
			},
			removeBindingsBySessionId: () => 0,
			markNeedsRelogin: () => {
				state.relogin += 1;
			},
			setDisplayName: () => undefined,
			// 模型链与默认工作区：默认空（不干预会话模型、不指定工作区），需要测顺延/工作区的用例自己改 state。
			getSettings: () => ({ enabled: true, account: state.account, modelChain: state.modelChain ?? [], defaultWorkspaceId: state.defaultWorkspaceId }),
		},
	};
}

/** 组装桥接 + 所有假依赖。 */
function createHarness({ account = { ilinkBotId: "bot@im.bot", ilinkUserId: "wxid_me", displayName: "我", baseUrl: "https://ilinkai.weixin.qq.com", loggedInAt: 1 }, token = "TOKEN", allowedUsers = ["wxid_me"], projects = [{ id: "p1", name: "PiDeck" }], bindings = [], batches = [], failTypingWith = null } = {}) {
	const client = makeClientStub({ batches, failTypingWith });
	const config = makeConfigStub({ account, token, allowedUsers, bindings });
	const tabs = [];
	const messages = new Map();
	const prompts = [];
	let listener = null;

	const sessionCreations = [];
	// 模型切换必须可观测：模型链的全部行为都落在「到底切到了哪个模型」上。
	// getRuntimeState 跟着 setRuntimeModel 走，模拟真实的读回（否则每次都会重复发同一个切换）。
	const modelSwitches = [];
	// 思考档位切换也要可观测：微信 run 的「关思考」是一个会写回会话偏好的副作用。
	const thinkingSwitches = [];
	let runtimeState;

	const runtimeBindings = {
		ensureSession: async ({ projectId, title }) => {
			sessionCreations.push({ projectId, title });
			return { sessionId: "s1", projectId, title, sessionPath: "/tmp/s1.jsonl" };
		},
		activateRuntime: async (sessionId) => {
			const tab = { id: "a1", projectId: "p1", sessionId, sessionPath: "/tmp/s1.jsonl", status: "idle", title: "微信对话" };
			tabs.push(tab);
			return tab;
		},
		bindRuntime: async ({ existingSessionId }) => ({ sessionId: existingSessionId ?? "s1" }),
		sendPrompt: async (input) => {
			prompts.push(input);
		},
		abortRuntime: async () => undefined,
		listRuntimeModels: async () => [],
		getRuntimeState: async () => runtimeState,
		setRuntimeModel: async (sessionId, provider, modelId) => {
			modelSwitches.push({ sessionId, provider, modelId });
			runtimeState = { ...runtimeState, provider, modelId };
		},
		setRuntimeThinking: async (sessionId, level) => {
			thinkingSwitches.push({ sessionId, level });
			runtimeState = { ...runtimeState, thinkingLevel: level };
		},
		sendUIResponse: async () => undefined,
	};

	const agentManager = {
		list: () => [...tabs],
		getMessages: (agentId) => messages.get(agentId) ?? [],
		addLocalEventListener: (fn) => {
			listener = fn;
			return () => {
				listener = null;
			};
		},
	};

	const sandbox = createTsSandbox({
		stubs: {
			"./IlinkClient": client,
			"./WeChatConfig": { ...config.api, normalizeModelChain },
		},
	});
	const { WeChatBridge } = sandbox("src/main/wechat/WeChatBridge.ts");

	const statuses = [];
	const bridge = new WeChatBridge({
		agentManager,
		getProjects: () => projects,
		runtimeBindings,
		getLocale: () => "zh-CN",
		botAgent: "PiDeck/test",
		onStatusChange: (status) => statuses.push(status),
		onBindingsChange: () => undefined,
	});

	return {
		bridge,
		client,
		config,
		statuses,
		prompts,
		tabs,
		messages,
		sessionCreations,
		modelSwitches,
		thinkingSwitches,
		// 个别用例需要临时把某个网关方法换成会抛错的实现（验证「辅助动作失败不影响回信」）。
		runtimeBindings,
		// 让挂在 run 上的 300s 超时定时器收尾，否则测试进程会被它拖住到超时。
		finishPendingRun: async () => {
			listener?.("a1", { type: "agent_end" });
			await new Promise((resolve) => setTimeout(resolve, 900));
			await bridge.stop();
		},
		emitAgentEvent: (agentId, event) => listener?.(agentId, event),
		hasListener: () => listener !== null,
		start: async () => {
			await bridge.start();
		},
	};
}

/** 一条来自白名单用户的文本消息。 */
function userMessage({ id = 1, from = "wxid_me", text = "你好", contextToken = "CTX-1", groupId = undefined, items = undefined } = {}) {
	return {
		message_id: id,
		message_type: MESSAGE_TYPE_USER,
		from_user_id: from,
		context_token: contextToken,
		group_id: groupId,
		item_list: items ?? [{ type: 1, text_item: { text } }],
	};
}

test("no bound account means disconnected and no polling at all", async () => {
	const harness = createHarness({ account: null, allowedUsers: [] });
	await harness.start();

	assert.equal(harness.bridge.getStatus().status, "disconnected");
	assert.equal(harness.client.calls.getUpdates, 0);
});

test("an account waiting for re-login reports a login error instead of polling with a dead token", async () => {
	const harness = createHarness({ account: { ilinkBotId: "bot@im.bot", ilinkUserId: "wxid_me", displayName: "我", baseUrl: "https://ilinkai.weixin.qq.com", loggedInAt: 1, needsRelogin: true } });
	await harness.start();

	const status = harness.bridge.getStatus();
	assert.equal(status.status, "error");
	assert.equal(status.errorMessage, "login-required");
	assert.equal(harness.client.calls.getUpdates, 0);
	assert.equal(harness.client.calls.notifyStart, 0);
});

test("an undecryptable token is surfaced rather than sent as ciphertext", async () => {
	// 换机器后 safeStorage 解不开：密文不能当 token 发出去，也不能假装已登录。
	const harness = createHarness({ token: "" });
	await harness.start();

	const status = harness.bridge.getStatus();
	assert.equal(status.status, "error");
	assert.equal(status.errorMessage, "credential-unavailable");
	assert.equal(harness.client.calls.getUpdates, 0);
});

test("a message from anyone other than the scanning account is ignored", async () => {
	// iLink 不校验消息来源，白名单是唯一防线：非绑定用户连回执都不该有。
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ from: "wxid_stranger" })] }] });
	await harness.start();

	await waitFor(() => harness.client.calls.getUpdates >= 1, "the first poll");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(harness.client.calls.sent.length, 0);
	assert.equal(harness.prompts.length, 0);
});

test("a message from the bound account is answered with the agent's reply", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ text: "写个函数" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt to reach the agent");
	assert.equal(harness.prompts[0].sessionId, "s1");
	assert.equal(harness.prompts[0].message, "写个函数");
	assert.ok(harness.prompts[0].agentMessage.includes("写个函数"), "the agent needs to know it is on a text-only channel");

	// Agent 跑完 → 桥接取最近一条助手消息回信。
	harness.messages.set("a1", [
		{ role: "user", text: "写个函数" },
		{ role: "assistant", text: "**好了**，见 `x.ts`" },
	]);
	harness.emitAgentEvent("a1", { type: "agent_end" });

	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].toUserId, "wxid_me");
	assert.equal(harness.client.calls.sent[0].contextToken, "CTX-1", "the reply must carry the message's context token");
	assert.equal(harness.client.calls.sent[0].text, "好了，见 x.ts", "markdown must be degraded before sending");
	await harness.bridge.stop();
});

test("a replayed message id is processed only once", async () => {
	// 游标回退会重放消息，重复执行等于重复跑 Agent。
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ id: 7 }), userMessage({ id: 7 })] }] });
	await harness.start();

	await waitFor(() => harness.client.calls.getUpdates >= 1, "the first poll");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(harness.prompts.length, 1);
	assert.equal(harness.config.state.bindings.size, 1, "重放不得重复建绑定/会话");
	await harness.finishPendingRun();
});

test("a group message is refused explicitly because only 1:1 is supported", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ groupId: "g1" })] }] });
	await harness.start();

	await waitFor(() => harness.client.calls.sent.length === 1, "the refusal");
	assert.equal(harness.prompts.length, 0, "a group message must not reach the agent");
	await harness.bridge.stop();
});

test("an attachment-only message is answered instead of silently dropped", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ items: [{ type: 2 }] })] }] });
	await harness.start();

	await waitFor(() => harness.client.calls.sent.length === 1, "the notice");
	assert.equal(harness.prompts.length, 0);
	await harness.bridge.stop();
});

test("a second message during a run gets a busy notice rather than queueing", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ id: 1, text: "长任务" })] }, { msgs: [userMessage({ id: 2, text: "还在吗" })] }] });
	await harness.start();

	// 第一条占住 run 槽（Agent 永远不会结束），第二条必须立刻收到「忙」而不是排进队列。
	await waitFor(() => harness.prompts.length === 1, "the first prompt");
	await waitFor(() => harness.client.calls.getUpdates >= 2, "the second poll");
	await waitFor(() => harness.client.calls.sent.length === 1, "the busy notice");
	assert.equal(harness.prompts.length, 1, "a busy channel must not start a second run");
	await harness.finishPendingRun();
});

test("/help answers without touching the agent", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [userMessage({ text: "/help" })] }] });
	await harness.start();

	await waitFor(() => harness.client.calls.sent.length === 1, "the help text");
	assert.equal(harness.prompts.length, 0, "commands must not occupy the run slot");
	await harness.bridge.stop();
});

test("a session-expired error stops polling and asks for a new scan", async () => {
	// 官方要求 -14 之后暂停该账号所有调用一小时；自动重试会触发风控。
	const harness = createHarness({ allowedUsers: ["wxid_me"] });
	harness.client.failOnce(harness.client.error("session-expired", "session expired"));
	await harness.start();

	await waitFor(() => harness.config.state.relogin >= 1, "the re-login flag");
	await waitFor(() => harness.bridge.getStatus().errorMessage === "login-required", "the login-required status");
	const pollsAfterFailure = harness.client.calls.getUpdates;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(harness.client.calls.getUpdates, pollsAfterFailure, "polling must stop, not retry");
	await harness.bridge.stop();
});

test("a transient poll failure is retried instead of killing the channel", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"] });
	harness.client.failOnce(new Error("network down"));
	await harness.start();

	// 第一次失败后按退避重试：状态仍是 connected（不能因为一次抖动就显示断开）。
	await waitFor(() => harness.client.calls.getUpdates >= 2, "the retry", 6000);
	assert.equal(harness.bridge.getStatus().status, "connected");
	await harness.bridge.stop();
});

test("the poll cursor is persisted so a restart does not replay the backlog", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"], batches: [{ msgs: [], cursor: "CUR-9" }] });
	await harness.start();

	await waitFor(() => harness.config.state.cursor === "CUR-9", "the cursor to be persisted");
	await harness.bridge.stop();
});

test("stop() detaches agent events so a stopped bridge cannot deliver late", async () => {
	const harness = createHarness({ allowedUsers: ["wxid_me"] });
	await harness.start();
	assert.equal(harness.hasListener(), true);

	await harness.bridge.stop();
	assert.equal(harness.hasListener(), false);
	assert.equal(harness.client.calls.notifyStop, 1);
});

// ===== 模型链（默认 + 兜底）=====
//
// 用户的动机是「有些模型贵，不想在微信回复里用」：链条必须真能拦在用错模型之前，
// 并且失败时顺延而不是静默失败。这些行为跨「建会话 → 提交 → agent_end → 再提交」，
// 只能靠真跑一遍事件流钉住。

/** 配一条两段模型链，返回 harness。 */
function createChainHarness({ batches } = {}) {
	const harness = createHarness({ batches });
	harness.config.state.modelChain = [
		{ provider: "p1", modelId: "fast", modelName: "Fast" },
		{ provider: "p2", modelId: "smart", modelName: "Smart" },
	];
	return harness;
}

/** 把一次 run 的结果通告给桥接。 */
function endRun(harness, event = {}) {
	harness.emitAgentEvent("a1", { type: "agent_end", ...event });
}

test("a configured model chain pins a new session to its first entry", async () => {
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "在吗" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the first prompt");
	assert.deepEqual(harness.modelSwitches, [{ sessionId: "s1", provider: "p1", modelId: "fast" }], "链首应当是新会话的默认模型");

	harness.messages.set("a1", [{ role: "assistant", text: "在的" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "在的");
	await harness.bridge.stop();
});

test("a run that ends in an error falls through to the next model in the chain", async () => {
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "解释一下" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the first attempt");
	endRun(harness, { stopReason: "error", errorMessage: "供应商 500" });
	await waitFor(() => harness.prompts.length === 2, "the retry on the next model");
	assert.deepEqual(
		harness.modelSwitches.map((entry) => `${entry.provider}/${entry.modelId}`),
		["p1/fast", "p2/smart"],
	);

	harness.messages.set("a1", [{ role: "assistant", text: "重试后的答案" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "重试后的答案");
	assert.equal(harness.prompts.length, 2, "重试成功后不得再顺延");
	await harness.bridge.stop();
});

test("a retry that produces no text does not resend the failed attempt's error", async () => {
	// 上一次尝试留下的错误文本还在消息流里：投递必须从本轮切片，否则会把旧错误当结果回信。
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "帮我看下" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the first attempt");
	harness.messages.set("a1", [{ role: "assistant", content: [{ type: "error", text: "供应商 500" }] }]);
	endRun(harness, { stopReason: "error", errorMessage: "供应商 500" });
	await waitFor(() => harness.prompts.length === 2, "the retry");

	// 重试这次只有用户消息，没有任何可回信的助手文本。
	harness.messages.set("a1", [...harness.messages.get("a1"), { role: "user", text: "继续" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.ok(!harness.client.calls.sent[0].text.includes("供应商 500"), "旧错误文本不得被当成结果回信");
	assert.ok(harness.client.calls.sent[0].text.includes("没有可回复的文本"), "应当说明本轮没有输出");
	await harness.bridge.stop();
});

test("when every model in the chain fails the last error is what the user sees", async () => {
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "跑一下" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the first attempt");
	endRun(harness, { stopReason: "error", errorMessage: "first failed" });
	await waitFor(() => harness.prompts.length === 2, "the second attempt");
	endRun(harness, { stopReason: "error", errorMessage: "second failed" });
	await waitFor(() => harness.client.calls.sent.length === 1, "the failure notice");
	assert.ok(harness.client.calls.sent[0].text.includes("second failed"), "必须回最后一条错误");
	assert.ok(!harness.client.calls.sent[0].text.includes("first failed"));
	await harness.bridge.stop();
});

test("a run the user aborted is not retried on the next model", async () => {
	// /stop 之后换个模型接着跑，等于把用户已经停掉的活又干了一遍。
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "停一下" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the attempt");
	endRun(harness, { stopReason: "aborted" });
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.prompts.length, 1, "abort 不算失败，不得顺延");
	assert.deepEqual(
		harness.modelSwitches.map((entry) => entry.modelId),
		["fast"],
	);
	await harness.bridge.stop();
});

test("an error pi will retry itself does not trigger the fallback", async () => {
	// willRetry=true 说明 pi 已经排了自己的重试：此时顺延会把同一轮跑两次。
	const harness = createChainHarness({ batches: [{ msgs: [userMessage({ text: "再看下" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the attempt");
	harness.messages.set("a1", [{ role: "assistant", text: "重试成功" }]);
	endRun(harness, { stopReason: "error", errorMessage: "rate limited", willRetry: true });
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.prompts.length, 1);
	assert.deepEqual(
		harness.modelSwitches.map((entry) => entry.modelId),
		["fast"],
	);
	await harness.bridge.stop();
});

test("without a model chain the session model is left untouched", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({ text: "旧行为" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt");
	assert.deepEqual(harness.modelSwitches, [], "没配模型链就不干预会话模型");
	harness.messages.set("a1", [{ role: "assistant", text: "照旧" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "照旧");
	await harness.bridge.stop();
});

// ===== 默认工作区 =====

test("the configured default workspace decides where a new session is created", async () => {
	const harness = createHarness({
		projects: [
			{ id: "p1", name: "PiDeck" },
			{ id: "p2", name: "Notes" },
		],
		batches: [{ msgs: [userMessage({})] }],
	});
	harness.config.state.defaultWorkspaceId = "p2";
	await harness.start();

	await waitFor(() => harness.sessionCreations.length === 1, "the session");
	assert.equal(harness.sessionCreations[0].projectId, "p2");
	// 必须先等到 prompt 真正提交：finishPendingRun 发的 agent_end 需要 run 已经登记等待器，
	// 否则事件落在登记之前，等待器会白等满 300s 超时（进程也跟着挂住）。
	await waitFor(() => harness.prompts.length === 1, "the prompt");
	await harness.finishPendingRun();
});

test("a default workspace that no longer exists falls back to the first project", async () => {
	// 工作区被删掉后设置里的 id 会变成悬空值：不能丢掉整个会话。
	const harness = createHarness({ projects: [{ id: "p1", name: "PiDeck" }], batches: [{ msgs: [userMessage({})] }] });
	harness.config.state.defaultWorkspaceId = "gone";
	await harness.start();

	await waitFor(() => harness.sessionCreations.length === 1, "the session");
	assert.equal(harness.sessionCreations[0].projectId, "p1");
	await waitFor(() => harness.prompts.length === 1, "the prompt");
	await harness.finishPendingRun();
});

test("an existing chat keeps its own workspace over the configured default", async () => {
	const harness = createHarness({
		projects: [
			{ id: "p1", name: "PiDeck" },
			{ id: "p2", name: "Notes" },
		],
		bindings: [{ chatId: "wxid_me", userId: "wxid_me", sessionId: "s1", sessionPath: "/tmp/s1.jsonl", workspaceId: "p2", createdAt: 1 }],
		batches: [{ msgs: [userMessage({})] }],
	});
	harness.config.state.defaultWorkspaceId = "p1";
	await harness.start();

	await waitFor(() => harness.sessionCreations.length === 1, "the session");
	assert.equal(harness.sessionCreations[0].projectId, "p2", "已有绑定不得被默认工作区搬走");
	await waitFor(() => harness.prompts.length === 1, "the prompt");
	await harness.finishPendingRun();
});

// ===== 出站请求形状：client_id / run_id / 正在输入 =====

test("outbound replies carry a stable client_id and a fresh run_id per run", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({})] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the first prompt");
	harness.messages.set("a1", [{ role: "assistant", text: "第一句" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the first reply");

	const first = harness.client.calls.sent[0];
	assert.match(first.clientId, /^pideck-[0-9a-f]{16}$/, "client_id 按 Bot 账号稳定派生（官方插件每条出站消息都带）");
	assert.equal(typeof first.runId, "string");
	assert.equal(first.runId.length, 36, "run_id 是每次 run 生成的 UUID");

	// 第二条消息＝新 run：client_id 必须不变（同一个客户端），run_id 必须换新（另一次生成）。
	harness.client.push({ msgs: [userMessage({ id: 2, text: "再来一句" })] });
	await waitFor(() => harness.prompts.length === 2, "the second prompt");
	harness.messages.set("a1", [...harness.messages.get("a1"), { role: "assistant", text: "第二句" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 2, "the second reply");

	assert.equal(harness.client.calls.sent[1].clientId, first.clientId);
	assert.notEqual(harness.client.calls.sent[1].runId, first.runId);
	await harness.bridge.stop();
});

test("typing signals mark start and stop, and a typing failure never blocks the reply", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({})] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt");
	assert.deepEqual(
		harness.client.calls.typing.map((call) => call.status),
		[1],
		"开始处理就先亮「正在输入」",
	);
	assert.equal(harness.client.calls.getConfig, 1, "开始/结束共用一张凭证");

	harness.messages.set("a1", [{ role: "assistant", text: "好了" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.typing.length === 2, "the stop signal");
	assert.deepEqual(
		harness.client.calls.typing.map((call) => call.status),
		[1, 2],
		"run 结束必须收掉「正在输入」",
	);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "好了");
	await harness.bridge.stop();

	// typing 失败只算下行探针失败：回信照常，且不能把通道标成 send-failed。
	const broken = createHarness({ batches: [{ msgs: [userMessage({})] }], failTypingWith: new Error("typing down") });
	await broken.start();
	await waitFor(() => broken.prompts.length === 1, "the prompt with broken typing");
	broken.messages.set("a1", [{ role: "assistant", text: "照样回" }]);
	endRun(broken);
	await waitFor(() => broken.client.calls.sent.length === 1, "the reply despite typing failure");
	assert.equal(broken.client.calls.sent[0].text, "照样回");
	assert.equal(broken.client.calls.typing.length, 0, "凭证都取不到就不发 typing");
	assert.notEqual(broken.statuses.at(-1)?.errorMessage, "send-failed", "探针失败不算发送失败");
	await broken.finishPendingRun();
});

// ===== 思考档位与回信内容 =====

test("微信驱动的 run 提交前先把思考档位关掉", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({ text: "写个函数" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt");
	assert.deepEqual(harness.thinkingSwitches, [{ sessionId: "s1", level: "off" }], "提交前先关思考（微信只有纯文本，推理过程对用户无用还照样计费）");
	await harness.finishPendingRun();
});

test("思考档位已经是 off 就不重复切换", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({ text: "在吗" })] }] });
	harness.runtimeBindings.getRuntimeState = async () => ({ provider: "p1", modelId: "fast", thinkingLevel: "off" });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt");
	assert.deepEqual(harness.thinkingSwitches, [], "已经是 off 就不要再发一次切换（免得往会话历史里写多余记录）");
	await harness.finishPendingRun();
});

test("关思考失败也要照常回信", async () => {
	const harness = createHarness({ batches: [{ msgs: [userMessage({ text: "在吗" })] }] });
	harness.runtimeBindings.setRuntimeThinking = async () => {
		throw new Error("thinking level rejected");
	};
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt despite thinking failure");
	harness.messages.set("a1", [{ role: "assistant", text: "在" }]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "在");
	await harness.bridge.stop();
});

test("只有思考、没有正文的消息不会被当成回信", async () => {
	// pi 把 thinking 以 <thinking>…</thinking> 并进消息正文：最后一条是纯思考时必须往前找。
	const harness = createHarness({ batches: [{ msgs: [userMessage({ text: "在吗" })] }] });
	await harness.start();

	await waitFor(() => harness.prompts.length === 1, "the prompt");
	harness.messages.set("a1", [
		{ role: "assistant", text: "**真正的回答**" },
		{ role: "assistant", text: "<thinking>再想想</thinking>" },
	]);
	endRun(harness);
	await waitFor(() => harness.client.calls.sent.length === 1, "the reply");
	assert.equal(harness.client.calls.sent[0].text, "真正的回答", "不能把思考发成回信");
	await harness.bridge.stop();
});
