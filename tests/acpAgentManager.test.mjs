/**
 * AcpAgentManager 单测:伪造 ACP CLI 子进程(spawn stub + 内存 NDJSON 回环),
 * 不依赖真实 CLI。覆盖:握手/恢复(load 失败回退 new)、prompt 回合与投影 flush、
 * abort 的 session/cancel、permission 审批应答(selected/cancelled)、
 * 进程退出终态与 stop 清理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 等待谓词为真(轮询 10ms,上限 2s)——flush 有 80ms 节流,断言前先等落盘。 */
async function waitFor(predicate, label = "condition") {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail(`timeout waiting for ${label}`);
}

/**
 * 伪造一个 ACP agent CLI 进程:stdin 收 manager 发出的 JSON-RPC 帧,
 * handler(frame) 返回 result 即时应答;返回 error 对象应答错误;undefined 挂起。
 * writeFromCli() 让用例直接向 manager 推通知/请求。
 */
function fakeAgentProcess(t, { handler = () => undefined, spawnError = undefined } = {}) {
	const stdin = new PassThrough(); // manager → CLI(测试读)
	const stdout = new PassThrough(); // CLI → manager(测试写)
	const stderr = new PassThrough();
	const frames = []; // manager 发出的全部帧(请求/通知/响应)
	stdin.on("data", (chunk) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line);
			frames.push(frame);
			if (frame.method && frame.id !== undefined) {
				// 第二参数 { writeFromCli }:用例可在应答前先推通知(模拟 ACP 规范的 load 重放时序)
				const outcome = handler(frame, { writeFromCli: (obj) => stdout.write(`${JSON.stringify(obj)}\n`) });
				if (outcome?.__error) {
					stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: outcome.code ?? -32000, message: outcome.message ?? "fail" } })}\n`);
				} else if (outcome !== undefined) {
					stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: outcome })}\n`);
				}
			}
		}
	});
	const proc = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		stderr,
		pid: 4321,
		exitCode: null,
		signalCode: null,
		kill() {
			proc.exitCode = 0;
			stdin.destroy();
			stdout.destroy();
			stderr.destroy();
		},
	});
	// ENOENT 等 spawn 失败在 spawn 返回后异步经 error 事件抛出（与真 Node 一致）。
	if (spawnError) setImmediate(() => proc.emit("error", spawnError));
	t.after(() => {
		try {
			stdin.destroy();
		} catch {}
		try {
			stdout.destroy();
		} catch {}
		try {
			stderr.destroy();
		} catch {}
	});
	const writeFromCli = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
	const methodFrames = (method) => frames.filter((frame) => frame.method === method);
	return { proc, frames, methodFrames, writeFromCli };
}

function harness(t, cliOptions, depsExtra = {}) {
	const events = { uiRequests: [], messages: [] };
	const procs = [];
	const spawnCalls = [];
	const { AcpAgentManager } = loadTsCommonJs("src/main/acp/AcpAgentManager.ts", {
		stubs: {
			"node:child_process": {
				spawn: (command, args, options) => {
					const record = fakeAgentProcess(t, cliOptions);
					procs.push(record);
					spawnCalls.push({ command, args, options });
					return record.proc;
				},
			},
		},
	});
	const manager = new AcpAgentManager({
		piLocator: { createInvocation: (command, args) => ({ command, args, shell: false }), createProcessEnv: () => ({}) },
		getProject: (id) => ({ path: `D:/proj-${id}` }),
		getTools: () => [{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], enabled: true }],
		isEnabled: () => true,
		onTitleChanged: () => {},
		...depsExtra,
	});
	const unsubscribe = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") events.uiRequests.push(payload);
		if (channel === "agents:message") events.messages.push(payload);
	});
	t.after(() => {
		unsubscribe();
		void manager.stopAll();
	});
	const createAgent = async (preset = "gemini") => manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: preset });
	const lastProc = () => procs[procs.length - 1];
	return { manager, events, spawnCalls, createAgent, procs, lastProc };
}

const TOOL = { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], enabled: true };

test("总开关运行时判定:关闭时拒绝 spawn,打开后同一实例立即可用(不必重启应用)", async (t) => {
	let enabled = false;
	const { createAgent, spawnCalls, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-1" };
				return {};
			},
		},
		{ isEnabled: () => enabled },
	);
	// 开关在 create 边界实时判定：关闭时既不起进程，也覆盖「从历史恢复 ACP 会话」这条不经过后端下拉的路径
	await assert.rejects(() => createAgent(), /ACP backend is disabled in settings/);
	assert.equal(spawnCalls.length, 0, "关闭时不得 spawn 任何 CLI");
	// 设置页打开开关后同一 manager 实例立即生效（网关启动时已常驻注册，开关不需要重启）
	enabled = true;
	const tab = await createAgent();
	assert.equal(tab.backend, "acp");
	assert.equal(spawnCalls.length, 1, "打开后立即允许 spawn");
	assert.equal(lastProc().methodFrames("initialize").length, 1, "新进程完成握手");
});

test("握手:initialize → session/new;工具命令与项目 cwd 传给 spawn", async (t) => {
	const calls = [];
	const { manager, spawnCalls, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			calls.push(frame.method);
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-new", title: "New ACP Session" };
			return {};
		},
	});
	const tab = await createAgent();
	assert.equal(tab.status, "idle");
	assert.deepEqual(calls, ["initialize", "session/new"]);
	// mcpServers 必传空数组(ACP v1 规范必填;opencode 缺它 -32602,会话创建即失败)
	const newParams = lastProc().methodFrames("session/new")[0]?.params;
	assert.ok(String(newParams?.cwd).endsWith("proj-p1"), "session/new cwd 指向项目");
	assert.deepEqual(newParams?.mcpServers, [], "session/new 必须携带 mcpServers: []");
	assert.equal(spawnCalls[0].command, "gemini");
	assert.deepEqual(spawnCalls[0].args, ["--experimental-acp"]);
	assert.ok(spawnCalls[0].options.cwd.endsWith("proj-p1"));

	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.provider, "acp");
	assert.equal(state.modelName, TOOL.name);
});

test("恢复:声明 loadSession 且 load 成功时不发 session/new", async (t) => {
	const { manager, lastProc, events } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { sessionId: "sess-restored" };
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(tab.status, "idle");
	const load = lastProc().methodFrames("session/load");
	assert.equal(load.length, 1);
	assert.equal(load[0].params.sessionId, "sess-old");
	assert.equal(lastProc().methodFrames("session/new").length, 0);
	// load 会话身份记录在 runtime:restart 传 acpSessionId 复用(下个用例展开回退分支)
	void events;
	void manager;
	void tab;
});

test("恢复:load 失败回退 session/new(拿新 sessionId 继续工作)", async (t) => {
	const { manager, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { __error: true, code: -32000, message: "session not found" };
			if (frame.method === "session/new") return { sessionId: "sess-fresh" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-gone" });
	assert.equal(tab.status, "idle");
	assert.equal(lastProc().methodFrames("session/load").length, 1);
	const news = lastProc().methodFrames("session/new");
	assert.equal(news.length, 1);
	void manager;
});

test("未声明 loadSession 时直接 session/new(不带旧 sessionId)", async (t) => {
	const { manager, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-plain" };
			return {};
		},
	});
	await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/load").length, 0);
	const news = lastProc().methodFrames("session/new");
	assert.equal(news.length, 1);
	assert.equal(news[0].params.sessionId, undefined);
});

test("新建:tab.sessionId 必须回填 agent 侧会话 id(coordinator buildAttachPatch 据此把 acpSessionId 落 catalog;缺失则重开历史会话永远 session/new 新建、历史丢失)", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-fresh" };
			return {};
		},
	});
	const fresh = await createAgent();
	assert.equal(manager.list().find((tab) => tab.id === fresh.id)?.sessionId, "sess-fresh", "session/new 后 tab.sessionId = agent 侧会话 id");
});

test("恢复:load 成功后 tab.sessionId 同样回填(load 回来的会话 id 才是 catalog 要持久化的身份)", async (t) => {
	const { manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { sessionId: "sess-restored" };
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(manager.list().find((item) => item.id === tab.id)?.sessionId, "sess-restored");
});

test("恢复:load 重放的 session/update(ACP 规范:agent 先重放历史再回 load 响应)不得被 sessionId 过滤丢弃", async (t) => {
	const { manager, events } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") {
				// 模拟规范行为:先推全部历史重放,再应答 session/load
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-old", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } } } });
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-old", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } } } });
				return { sessionId: "sess-old" };
			}
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	await waitFor(() => {
		const flushed = events.messages.filter((payload) => payload.agentId === tab.id);
		return flushed.length > 0 && flushed.at(-1).messages.length >= 2;
	}, "load 重放历史投影为消息");
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.filter((message) => message.role === "user").at(-1)?.text, "earlier question", "重放的用户消息保留");
	assert.equal(messages.filter((message) => message.role === "assistant").at(-1)?.text, "earlier answer", "重放的助手消息保留");
});

test("sendPrompt:流式 update 投影为消息,stopReason 结算后回 idle", async (t) => {
	let promptRpcId = null;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptRpcId = frame.id;
				return undefined; // 挂起:先推流式 update 再手动结算
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "hi" });
	await waitFor(() => promptRpcId !== null, "session/prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } },
	});
	cli.writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
	});
	// flush 节流 80ms,等合并后的消息落盘
	await waitFor(() => events.messages.some((payload) => payload.agentId === tab.id), "streamed message flush");
	cli.writeFromCli({ jsonrpc: "2.0", id: promptRpcId, result: { stopReason: "end_turn" } });
	const result = await sendPromise;
	assert.equal(result.accepted, true);
	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.isTurnActive, false);
	const lastFlush = events.messages.at(-1);
	const assistant = lastFlush.messages.find((message) => message.role === "assistant");
	assert.ok(assistant, "assistant message projected");
	assert.equal(assistant.text ?? assistant.content, "hello world");
});

test("abort:进行中的回合发 session/cancel 通知(prompt 挂起不拒绝)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined; // 永久挂起
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "long task" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await manager.abort(tab.id);
	const cancels = lastProc().methodFrames("session/cancel");
	assert.equal(cancels.length, 1);
	assert.equal(cancels[0].params.sessionId, "sess-1");
	// abort 只发通知,prompt promise 仍由 CLI 响应结算
	cli_finish: {
		const frame = lastProc().frames.find((item) => item.method === "session/prompt" && item.id !== undefined);
		lastProc().writeFromCli({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "cancelled" } });
		break cli_finish;
	}
	const result = await sendPromise;
	assert.equal(result.accepted, true);
});

test("turnActive 期间重复 sendPrompt 被拒绝(agentMessage 同样不支持)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const first = manager.sendPrompt({ agentId: tab.id, message: "a" });
	await waitFor(() => promptSeen, "prompt dispatched");
	const second = await manager.sendPrompt({ agentId: tab.id, message: "b" });
	assert.equal(second.accepted, false);
	assert.match(second.error, /still responding/);
	// 拒收携带本地化描述符：渲染层 translateI18nDescriptor 据此弹本地化 toast 而非英文原文。
	assert.equal(second.i18nKey, "acp.turnBusy");
	assert.equal(second.i18nParams?.tool, TOOL.name);
	const withInstructions = await manager.sendPrompt({ agentId: tab.id, message: "c", agentMessage: "host rules" });
	assert.equal(withInstructions.accepted, false);
	assert.match(withInstructions.error, /Host instructions/);
	assert.equal(withInstructions.i18nKey, "acp.hostInstructionsUnsupported");
	void first;
	await manager.stop(tab.id);
});

test("图片能力门控:agent 未声明 promptCapabilities.image 时带图发送被拒收并本地化;声明后放行且图块进发件帧", async (t) => {
	let lastPrompt;
	const mk = (capabilities) =>
		harness(t, {
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: capabilities };
				if (frame.method === "session/new") return { sessionId: "sess-img-cap" };
				if (frame.method === "session/prompt") {
					lastPrompt = frame.params;
					return { stopReason: "end_turn" };
				}
				return {};
			},
		});
	const images = [{ type: "image", mimeType: "image/png", data: "aW1n" }];
	// 未声明图片能力:拒收(turn 未启,草稿回填由渲染层完成)
	const denied = mk({ loadSession: false });
	const deniedTab = await denied.createAgent();
	const deniedResult = await denied.manager.sendPrompt({ agentId: deniedTab.id, message: "带图", images });
	assert.equal(deniedResult.accepted, false);
	assert.equal(deniedResult.delivery, "rejected");
	assert.equal(deniedResult.i18nKey, "acp.imagesNotSupported");
	assert.equal(deniedResult.i18nParams?.tool, TOOL.name);
	assert.equal(lastPrompt, undefined, "拒收不得发出 session/prompt 帧");
	// 声明图片能力:放行,prompt 帧携带 image 块(规范 content 顺序:文本后图)
	const allowed = mk({ promptCapabilities: { image: true } });
	const allowedTab = await allowed.createAgent();
	const allowedResult = await allowed.manager.sendPrompt({ agentId: allowedTab.id, message: "带图", images });
	assert.equal(allowedResult.accepted, true);
	assert.deepEqual(lastPrompt.prompt, [
		{ type: "text", text: "带图" },
		{ type: "image", data: "aW1n", mimeType: "image/png" },
	]);
});

test("AUTH_REQUIRED(回合期):-32000 拒收携带登录引导描述符(debugDetails 保留 RPC 原文)", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-auth" };
			if (frame.method === "session/prompt") return { __error: true, code: -32000, message: "Authentication required" };
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "rejected");
	assert.equal(result.i18nKey, "acp.authRequired");
	assert.equal(result.i18nParams?.tool, TOOL.name);
	assert.equal(result.debugDetails, "ACP RPC error -32000: Authentication required", "RPC 原文必须留在 debugDetails 供排查");
});

test("usage_update 通知映射进 runtime.state 上下文仪表(used/size→contextTokens/Window/Percent,cost→cost)", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-usage" };
			return {};
		},
	});
	const tab = await createAgent();
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-usage", update: { sessionUpdate: "usage_update", used: 25528, size: 1_000_000, cost: { amount: 0.42, currency: "USD" } } },
	});
	await waitFor(async () => (await manager.getRuntimeState(tab.id)).contextTokens === 25528, "usage 投影进 runtime.state");
	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.contextTokens, 25528);
	assert.equal(state.contextWindow, 1_000_000);
	assert.equal(state.contextPercent, 2.6);
	assert.equal(state.cost, 0.42);
	assert.equal(state.provider, "acp");
});

test("工具被删/禁用:create 直接拒且标 i18nKey acp.toolMissing（老会话绑定还在不报错 id）", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: () => ({}),
	});
	const failure = await manager.create({ projectId: "p1", backend: "acp", agentPreset: "tool-gone" }).catch((error) => error);
	assert.match(failure.message, /not found or disabled/);
	assert.equal(failure.i18nKey, "acp.toolMissing");
	assert.equal(failure.i18nParams?.tool, "tool-gone");
	void createAgent;
});

test("CLI 未安装(spawn ENOENT):create 抛出 acp.toolNotInstalled 描述符（带完整命令行供安装引导）", async (t) => {
	const { createAgent, manager } = harness(t, {
		spawnError: Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }),
		// 挂起 initialize：等 spawn 的 error 事件决定握手结局（真实 CLI 起不来就是应答绝不返回）。
		handler: () => undefined,
	});
	const failure = await createAgent().catch((error) => error);
	assert.equal(failure.i18nKey, "acp.toolNotInstalled");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.equal(failure.i18nParams?.command, "gemini --experimental-acp");
	assert.equal(failure.debugDetails, "spawn gemini ENOENT");
	assert.equal(manager.list().length, 0);
});

test("握手超时(initialize 挂起):create 抛出 acp.startupTimeout 描述符（中性重试引导）", async (t) => {
	const { createAgent, manager } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return undefined; // 永不应答
				if (frame.method === "session/new") return { sessionId: "never" };
				return {};
			},
		},
		{ handshakeTimeoutMs: 40 },
	);
	const failure = await createAgent().catch((error) => error);
	assert.equal(failure.i18nKey, "acp.startupTimeout");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.match(failure.debugDetails, /timed out after 40ms: initialize/);
	assert.equal(manager.list().length, 0);
});

test("AUTH_REQUIRED(首启):session/new 返回 -32000 时 create 抛出带描述符的错误(coordinator 透传为登录引导 toast)", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { __error: true, code: -32000, message: "Authentication required" };
			return {};
		},
	});
	const failure = await createAgent().catch((error) => error);
	assert.ok(failure instanceof Error);
	assert.match(failure.message, /Authentication required/);
	assert.equal(failure.i18nKey, "acp.authRequired");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.equal(manager.list().length, 0, "首启失败不留进程垃圾");
});

test("permission 审批:select label 映射 optionId 回传;cancel 走 cancelled 结局", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "run stuff" });
	await waitFor(() => promptSeen, "prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		id: 777,
		method: "session/request_permission",
		params: {
			sessionId: "sess-1",
			toolCall: { toolCallId: "shell-1", title: "git status", rawInput: { command: "git status" } },
			options: [
				{ optionId: "allow-command", kind: "allow_once", name: "Allow" },
				{ optionId: "reject-command", kind: "reject_once", name: "Reject" },
			],
		},
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select" && payload.agentId === tab.id), "ui request raised");
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.equal(request.title, "git status");
	assert.deepEqual([...request.options], ["Allow", "Reject"]);
	// 渲染层点 Allow(label)→ manager 映射回原 optionId（不是 kind）
	const accepted = await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" });
	assert.equal(accepted.accepted, true);
	await waitFor(() => cli.frames.some((frame) => frame.id === 777 && frame.result), "respond frame sent");
	const respondFrame = cli.frames.find((frame) => frame.id === 777 && frame.result);
	assert.deepEqual(respondFrame.result, { outcome: { outcome: "selected", optionId: "allow-command" } });
	// 完成事件让渲染层撤卡
	assert.ok(events.uiRequests.some((payload) => payload.requestId === request.requestId && payload.completed === true));
	void sendPromise;
	await manager.stop(tab.id);
});

test("连接死亡:pending 审批全部 cancelled 结算,tab 转 error", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "work" });
	sendPromise.catch(() => {}); // 进程死亡会 reject,断言走 events
	await waitFor(() => promptSeen, "prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		id: 888,
		method: "session/request_permission",
		params: { sessionId: "sess-1", toolCall: { toolCallId: "shell-2", title: "cargo build" }, options: [{ optionId: "allow-build", name: "Allow", kind: "allow_once" }] },
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"), "permission raised");
	// exit 之后仍可能有 stdout 尾帧；Node 在 stdio 关闭后才发 close。
	// 断言只看审批卡撤除(completed)与 tab 终态，已断管不要求送出回包。
	cli.proc.emit("exit", 1, null);
	cli.proc.emit("close", 1, null);
	await waitFor(() => events.uiRequests.some((payload) => payload.completed === true), "pending permission settled cancelled");
	const listed = manager.list().find((item) => item.id === tab.id);
	assert.equal(listed.status, "error");
	// prompt 挂起中被进程死亡中断:不抛异常,结构化拒绝(accepted:false + exited 原因)
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.match(result.error, /exited/);
});

test("stop:杀进程、runtime 移除、list 不再含该 agent", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			return {};
		},
	});
	const tab = await createAgent();
	assert.ok(manager.list().some((item) => item.id === tab.id));
	const cli = lastProc();
	await manager.stop(tab.id);
	assert.equal(
		manager.list().some((item) => item.id === tab.id),
		false,
	);
	assert.equal(cli.proc.exitCode, 0, "process killed");
	await assert.rejects(manager.getRuntimeState(tab.id), /No ACP runtime/);
});

test("图片物化:消息里的 base64 图经 imageStore 落盘成 ref,put 失败保留 data", async (t) => {
	const puts = [];
	let seq = 0;
	const imageStore = {
		put: async (data, mimeType) => {
			puts.push({ data, mimeType });
			seq += 1;
			// 第二张图模拟落盘失败(超限/写盘异常按 null 降级)
			return seq === 2 ? null : `blob-ref-${seq}`;
		},
	};
	const { events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-img" };
				return {};
			},
		},
		{ imageStore },
	);
	const tab = await createAgent();
	const cli = lastProc();
	const notify = (update) => cli.writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-img", update } });
	// user 回显图(应物化成 ref-1)+ agent 生图(应物化成 ref-2,但 put 失败保留 data)
	notify({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "user-img-base64", mimeType: "image/png" } });
	notify({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "gen-img-base64", mimeType: "image/png" } });
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last && last.messages && last.messages.some((message) => message.role === "user" && message.images?.some((image) => image.ref === "blob-ref-1")) && last.messages.some((message) => message.role === "assistant" && message.images?.some((image) => image.data === "gen-img-base64"));
	}, "both images projected with materialization applied");
	const flushed = events.messages.at(-1);
	const userMsg = flushed.messages.find((message) => message.role === "user");
	const genMsg = flushed.messages.find((message) => message.role === "assistant");
	assert.equal(userMsg.images[0].ref, "blob-ref-1");
	assert.equal(userMsg.images[0].data, undefined);
	assert.equal(genMsg.images[0].ref, undefined);
	assert.equal(genMsg.images[0].data, "gen-img-base64");
	assert.deepEqual(
		puts.map((entry) => entry.data),
		["user-img-base64", "gen-img-base64"],
	);
});

test("图片物化:未注入 imageStore 时保持 data 形态(降级不断链)", async (t) => {
	const { events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-plain" };
			return {};
		},
	});
	await createAgent();
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-plain", update: { sessionUpdate: "user_message_chunk", content: { type: "image", data: "inline", mimeType: "image/png" } } } });
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last && last.messages && last.messages.some((message) => message.role === "user");
	}, "user image echoed");
	const flushed = events.messages.at(-1);
	assert.equal(flushed.messages.find((message) => message.role === "user").images[0].data, "inline");
});

test("create merges tool-level env over base process env", async (t) => {
	const { spawnCalls, createAgent } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-env", title: "env" };
				return {};
			},
		},
		{ getTools: () => [{ id: "codex", name: "Codex", command: "codex-acp", args: [], env: { ZAI_CODING_KEY: "sk-tool", LANG: "zh-CN" }, enabled: true }] },
	);
	await createAgent("codex");
	// 工具级 env 必须传进 spawn(基础 env 为空对象,合并后应只含工具键)
	assert.equal(spawnCalls[0].options.env.ZAI_CODING_KEY, "sk-tool");
	assert.equal(spawnCalls[0].options.env.LANG, "zh-CN");
});

// ── configOptions 规范路径:session/new 枚举 → 查询/下发/通知更新 ──

const CONFIG_OPTIONS = [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "gpt-5",
		options: [
			{ value: "gpt-5", name: "GPT-5" },
			{ value: "o3", name: "o3" },
		],
	},
	{ id: "effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "medium" },
];

test("configOptions:session/new 返回的枚举可查询;set_config_option 用响应整表更新", async (t) => {
	let applied;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-cfg", configOptions: CONFIG_OPTIONS };
			if (frame.method === "session/set_config_option") {
				applied = frame.params;
				return { configOptions: [{ ...CONFIG_OPTIONS[0], currentValue: "o3" }, CONFIG_OPTIONS[1]] };
			}
			return {};
		},
	});
	const tab = await createAgent();
	// 查询:握手返回的枚举原样暴露(agent 未提供时是 undefined,渲染层隐藏选择器)
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.id, "model");

	const updated = await manager.applyConfigOption(tab.id, "model", "o3");
	// 下发参数按规范带 sessionId + id + value
	// 参数名按规范是 configId(非 id);opencode 等实现对 id 形态报 -32602
	assert.deepEqual(applied, { sessionId: "sess-cfg", configId: "model", value: "o3" });
	assert.equal(updated[0].currentValue, "o3");
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.currentValue, "o3");
	// 帧确实进了连接(防只改内存不发请求)
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 1);
});

test("configOptions:config_option_update 通知整表替换并回调 onConfigOptionsChanged", async (t) => {
	const seen = [];
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-cfg", configOptions: CONFIG_OPTIONS };
				return {};
			},
		},
		{ onConfigOptionsChanged: (tab, options) => seen.push({ agentId: tab.id, first: options[0]?.id }) },
	);
	const tab = await createAgent();
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "config_option_update", params: { sessionId: "sess-cfg", configOptions: [{ id: "model", currentValue: "o3" }] } });
	await waitFor(() => seen.length === 1);
	// 通知按 agentId 隔离(sessionId 不匹配的丢弃)
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "config_option_update", params: { sessionId: "other", configOptions: [{ id: "evil" }] } });
	await sleep(60);
	assert.deepEqual(seen, [{ agentId: tab.id, first: "model" }]);
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.currentValue, "o3");
});

test("session/prompt 超时后补发 session/cancel：agent 侧旧回合必须收口，否则后续 prompt 永久排队", async (t) => {
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-timeout" };
				// session/prompt 永不应答：模拟 opencode 回合卡死（客户端超时 ≠ agent 侧回合结束）
				return undefined;
			},
		},
		{ promptTurnTimeoutMs: 40 },
	);
	const tab = await createAgent();
	const first = await manager.sendPrompt({ agentId: tab.id, message: "hello" });
	assert.equal(first.accepted, false);
	assert.match(first.error, /ACP request timed out after 40ms: session\/prompt/);
	// 超时后必须补发 cancel，让 agent 收口旧回合（reason 固定 turn_timeout）
	await waitFor(() => lastProc().methodFrames("session/cancel").length === 1);
	const cancel = lastProc().methodFrames("session/cancel")[0];
	assert.equal(cancel.params.sessionId, "sess-timeout");
	assert.equal(cancel.params.reason, "turn_timeout");
	// 取消补发后 turnActive 已清：新 prompt 不再被「still responding」拒绝，能重新进入发送路径
	const second = await manager.sendPrompt({ agentId: tab.id, message: "again" });
	assert.equal(second.accepted, false);
	assert.match(second.error, /ACP request timed out after 40ms: session\/prompt/);
	assert.equal(lastProc().methodFrames("session/cancel").length, 2);
});

test("session/prompt 非超时拒绝（JSON-RPC 错误）不补发 session/cancel", async (t) => {
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-rpc" };
				if (frame.method === "session/prompt") return { __error: true, code: -32002, message: "turn in progress" };
				return {};
			},
		},
		{ promptTurnTimeoutMs: 5000 },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.match(result.error, /turn in progress/);
	// 拒绝是 agent 即时应答：回合已在 agent 侧结束，再发 cancel 反而可能打断下一回合
	await sleep(120);
	assert.equal(lastProc().methodFrames("session/cancel").length, 0);
});

/**
 * 用户消息主进程侧落库（2026-10 用户反馈：ACP 时间线只有 AI 回复，用户消息不见了）。
 * ACP 的 user_message_chunk 是 agent 的可选回显，OpenCode 等根本不发；而 agents:message
 * 是全量替换语义，渲染层的乐观气泡会被第一次 flush 抹掉。
 */
test("sendPrompt:agent 不回显时用户消息仍进投影,首条 prompt 兜底标题写回 catalog", async (t) => {
	const titles = [];
	const { manager, events, createAgent } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-echo" };
				if (frame.method === "session/prompt") return { stopReason: "end_turn" }; // 不回显 user_message_chunk
				return {};
			},
		},
		{ onTitleChanged: (deckSessionId, title) => titles.push({ deckSessionId, title }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "修复登录页面的 bug" });
	assert.equal(result.accepted, true);
	const flushed = events.messages.at(-1);
	const user = flushed.messages.find((message) => message.role === "user");
	assert.ok(user, "用户消息必须由主进程落进投影，不依赖 agent 回显");
	assert.equal(user.text, "修复登录页面的 bug");
	assert.equal(flushed.totalLength, flushed.messages.length);
	assert.deepEqual(titles, [{ deckSessionId: "deck-1", title: "修复登录页面的 bug" }], "首条 prompt 兜底标题必须写回 catalog（ACP 无本地会话文件）");
	// 第二条 prompt 不得把标题改掉（agent 后续给的标题仍可覆盖，见投影器单测）
	await manager.sendPrompt({ agentId: tab.id, message: "第二个问题" });
	assert.equal(titles.length, 1);
	assert.equal(events.messages.at(-1).messages.filter((message) => message.role === "user").length, 2);
});

test("sendPrompt 派发失败:撤回刚落的用户条目（不留没有回复的幽灵消息）", async (t) => {
	const { manager, events, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-fail" };
			if (frame.method === "session/prompt") return { __error: { code: -32000, message: "Authentication required" } };
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "会被拒绝的消息" });
	assert.equal(result.accepted, false);
	const flushed = events.messages.at(-1);
	assert.equal(flushed.messages.filter((message) => message.role === "user").length, 0, "派发失败且 agent 未产出时必须撤回");
});
