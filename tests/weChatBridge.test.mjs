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
function makeClientStub({ batches = [], failWith = null } = {}) {
	const calls = { notifyStart: 0, notifyStop: 0, getUpdates: 0, sent: [] };
	const queue = [...batches];
	let cursor = "";
	let errorToThrow = failWith;

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
			// 队列空了就永远挂着：绝不能让长轮询变成紧循环（微任务风暴会饿死测试的定时器）。
			return new Promise(() => {});
		}
		async getConfig() {
			return { typing_ticket: "TICKET" };
		}
		async sendTyping() {
			calls.typing = (calls.typing ?? 0) + 1;
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
		push: (batch) => queue.push(batch),
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
		},
	};
}

/** 组装桥接 + 所有假依赖。 */
function createHarness({ account = { ilinkBotId: "bot@im.bot", ilinkUserId: "wxid_me", displayName: "我", baseUrl: "https://ilinkai.weixin.qq.com", loggedInAt: 1 }, token = "TOKEN", allowedUsers = ["wxid_me"], projects = [{ id: "p1", name: "PiDeck" }], bindings = [], batches = [] } = {}) {
	const client = makeClientStub({ batches });
	const config = makeConfigStub({ account, token, allowedUsers, bindings });
	const tabs = [];
	const messages = new Map();
	const prompts = [];
	let listener = null;

	const runtimeBindings = {
		ensureSession: async ({ projectId, title }) => ({ sessionId: "s1", projectId, title, sessionPath: "/tmp/s1.jsonl" }),
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
		getRuntimeState: async () => undefined,
		setRuntimeModel: async () => undefined,
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
			"./WeChatConfig": config.api,
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
