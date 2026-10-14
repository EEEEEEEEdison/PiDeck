import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import test from "node:test";

const { PiDeckMcpService } = loadTsCommonJs("src/main/mcp/PiDeckMcpService.ts");
const { HostPluginSessions } = loadTsCommonJs("src/main/plugins/HostPluginSessions.ts");
const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

async function fixture(t, override = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-mcp-"));
	const filePath = join(dir, "session.jsonl");
	await writeFile(
		filePath,
		[
			JSON.stringify({ type: "session", version: 3, id: "native", timestamp: new Date(0).toISOString(), cwd: dir }),
			...Array.from({ length: 105 }, (_, i) =>
				JSON.stringify({
					type: "message",
					id: `e${i}`,
					parentId: i ? `e${i - 1}` : null,
					message: {
						role: "user",
						content: [
							{ type: "text", text: `Message ${i}` },
							{ type: "image", data: "secret-image", mimeType: "image/png" },
						],
						timestamp: i,
					},
				}),
			),
		].join("\n") + "\n",
	);
	const entry = { id: "s1", projectId: "p1", filePath, title: "Find Me", updatedAt: 1, createdAt: 0 };
	const entries = [entry, { ...entry, id: "s2", projectId: "p2", title: "Private" }];
	const sessions = new HostPluginSessions({ listEntries: () => entries, get: (id) => entries.find((e) => e.id === id) });
	const projects = [
		{ id: "p1", name: "Allowed" },
		{ id: "p2", name: "Private" },
	];
	const configPath = join(dir, "mcp-host.json");
	const service = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined, ...override });
	t.after(async () => {
		await service.dispose();
		await rm(dir, { recursive: true, force: true });
	});
	return { service, projects, configPath, sessions, dir };
}

async function connect(t, service) {
	const config = await service.connection();
	const definition = config.mcpServers.pideck;
	const client = new Client({ name: "pideck-test", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers } });
	t.after(() => client.close());
	await client.connect(transport);
	return { client, definition };
}

test("MCP is off by default, has no endpoint/credential and exports disabled config only after consent", async (t) => {
	const { service, configPath } = await fixture(t);
	assert.deepEqual(plain(await service.getState()), {
		enabled: false,
		projectIds: [],
		// 旧配置文件没有这两个字段，默认值必须让升级后的行为原样延续：显式白名单 + 无写能力。
		allProjects: false,
		allowControl: false,
		running: false,
		projects: [
			{ id: "p1", name: "Allowed" },
			{ id: "p2", name: "Private" },
		],
	});
	await assert.rejects(service.connection(), /service-disabled/);
	await assert.rejects(readFile(configPath), { code: "ENOENT" });
	await assert.rejects(service.setAccess({ enabled: true, projectIds: [] }), /project-required/);
	await assert.rejects(service.setAccess({ enabled: true, projectIds: ["unknown"] }), /project-not-authorized/);
	const state = await service.setAccess({ enabled: true, projectIds: ["p1"] });
	assert.equal(state.running, true);
	assert.equal(JSON.stringify(state).includes("token"), false);
	const { client, definition } = await connect(t, service);
	assert.equal(definition.enabled, false);
	assert.match(definition.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.deepEqual(
		(await client.listTools()).tools.map((v) => v.name),
		["projects_list", "settings_get", "extensions_list", "runtime_status", "sessions_list", "sessions_get", "sessions_search", "sessions_entries"],
	);
	for (const tool of (await client.listTools()).tools) assert.equal(tool.annotations.readOnlyHint, true);
	// 写开关默认关：写工具不注册，客户端连看都看不到，而不是注册后拒绝。
	assert.equal((await service.getState()).allowControl, false);
});

test("宿主级工具 settings_get / extensions_list 只要求服务授权，不绑定项目白名单", async (t) => {
	const settings = createDefaultAppSettings();
	settings.removedBuiltInExtensions = ["pi-deck-todo.ts"];
	const { service } = await fixture(t, { settings: () => settings, builtInExtensionsVersion: () => "1.2.3" });
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const { client } = await connect(t, service);

	const hostSettings = await client.callTool({ name: "settings_get" });
	assert.equal(hostSettings.isError, undefined);
	assert.equal(hostSettings.structuredContent.data.agent.backend, settings.defaultAgentBackend);
	assert.equal(hostSettings.structuredContent.data.app.language, settings.language);
	const extensions = await client.callTool({ name: "extensions_list" });
	assert.equal(extensions.structuredContent.data.builtInVersion, "1.2.3");
	assert.equal(
		extensions.structuredContent.data.builtIn.some((entry) => entry.id === "pi-deck-todo.ts" && entry.enabled),
		false,
	);
	assert.equal(
		extensions.structuredContent.data.builtIn.some((entry) => entry.id === "pi-deck-shell-proxy.ts" && entry.enabled),
		true,
	);

	// 白名单收窄会同时轮换令牌（旧令牌立即失效），所以重新取一份连接；宿主级工具仍不要求项目。
	await service.setAccess({ enabled: true, projectIds: ["p2"] });
	const rotated = (await connect(t, service)).client;
	assert.equal((await rotated.callTool({ name: "settings_get" })).isError, undefined);
	assert.equal((await rotated.callTool({ name: "sessions_get", arguments: { projectId: "p1", sessionId: "s1" } })).isError, true);
});

test("宿主端口未就绪时宿主级工具返回空数据而不是报错或暴露内部错误码", async (t) => {
	const { service } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const { client } = await connect(t, service);
	for (const name of ["settings_get", "extensions_list"]) {
		const result = await client.callTool({ name });
		assert.equal(result.isError, undefined, `${name} 在宿主未就绪时不应报错`);
		assert.equal(result.structuredContent.data, null);
	}
});

test("real MCP client reads scoped metadata/search and bounded historical pages without image bytes or paths", async (t) => {
	const { service } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const { client } = await connect(t, service);
	const call = (name, args = {}) => client.callTool({ name, arguments: args });
	assert.deepEqual((await call("projects_list")).structuredContent.data, [{ id: "p1", name: "Allowed" }]);
	const listing = await call("sessions_list", { projectId: "p1" });
	assert.equal(listing.structuredContent.data.sessions.length, 1);
	assert.equal(JSON.stringify(listing).includes("filePath"), false);
	assert.equal((await call("sessions_search", { projectId: "p1", query: "find" })).structuredContent.data.length, 1);
	assert.equal((await call("sessions_get", { projectId: "p1", sessionId: "s1" })).structuredContent.data.title, "Find Me");
	assert.equal((await call("sessions_list", { projectId: "p2" })).isError, true);
	assert.equal((await call("sessions_get", { projectId: "p1", sessionId: "s2" })).isError, true);
	assert.equal((await call("sessions_entries", { projectId: "p1", sessionId: "s2" })).isError, true);
	assert.equal((await call("sessions_list", { projectId: "p1", offset: -1 })).isError, true);
	assert.equal((await call("sessions_list", { projectId: "p1", filePath: "untrusted" })).isError, true);
	const page = (await call("sessions_entries", { projectId: "p1", sessionId: "s1" })).structuredContent.data;
	assert.equal(page.entries.length, 100);
	assert.equal(JSON.stringify(page).includes("secret-image"), false);
	const older = (await call("sessions_entries", { projectId: "p1", sessionId: "s1", cursor: page.nextCursor })).structuredContent.data;
	assert.equal(older.entries.length, 5);
	assert.equal(older.nextCursor, null);
	const stale = await call("sessions_entries", { projectId: "p1", sessionId: "s1", cursor: { ...page.nextCursor, version: "stale" } });
	assert.match(stale.content[0].text, /stale-cursor/);
});

test("HTTP rejects unauthenticated, browser, foreign Host, batch and oversized input; disabling closes sockets", async (t) => {
	const { service } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const definition = (await service.connection()).mcpServers.pideck;
	const request = (headers = {}, body = "{}") => fetch(definition.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
	assert.equal((await request()).status, 401);
	assert.equal((await request({ ...definition.headers, Origin: "https://evil.invalid" })).status, 403);
	// Node fetch normalizes Host; use an actual HTTP request to exercise the wire boundary.
	const foreignHostStatus = await new Promise((resolve, reject) => {
		const req = httpRequest(definition.url, { method: "POST", headers: { ...definition.headers, Host: "evil.invalid" } }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(foreignHostStatus, 403);
	assert.equal((await request(definition.headers, "[]")).status, 400);
	assert.equal((await request(definition.headers, " ".repeat(65537))).status, 413);
	await service.setAccess({ enabled: false, projectIds: [] });
	assert.equal((await service.getState()).running, false);
	await assert.rejects(request(definition.headers));
	await assert.rejects(service.connection(), /service-disabled/);
});

test("scope changes rotate credentials and project removal denies access on existing connections", async (t) => {
	const { service, projects } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const old = (await service.connection()).mcpServers.pideck;
	await service.setAccess({ enabled: true, projectIds: ["p2"] });
	const { client, definition } = await connect(t, service);
	assert.equal(definition.url, old.url);
	assert.notEqual(definition.headers.Authorization, old.headers.Authorization);
	assert.equal((await fetch(old.url, { method: "POST", headers: old.headers })).status, 401);
	projects.splice(1, 1);
	const result = await client.callTool({ name: "sessions_list", arguments: { projectId: "p2" } });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /project-not-authorized/);
});

test("late history result cannot escape after consent is revoked", async (t) => {
	let release;
	let entered;
	const started = new Promise((r) => {
		entered = r;
	});
	const delayed = new Promise((r) => {
		release = r;
	});
	const { service } = await fixture(t, {
		sessions: {
			get: () => ({}),
			list: () => ({}),
			search: () => [],
			entries: () => {
				entered();
				return delayed;
			},
		},
	});
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const { client } = await connect(t, service);
	const pending = client.callTool({ name: "sessions_entries", arguments: { projectId: "p1", sessionId: "s1" } }).catch(() => ({ disconnected: true }));
	await started;
	await service.setAccess({ enabled: false, projectIds: [] });
	release({ entries: [{ text: "must-not-leak" }] });
	assert.equal(JSON.stringify(await pending).includes("must-not-leak"), false);
});

test("enabled consent survives restart with the same endpoint/token; disabled consent stays off", async (t) => {
	const { service, projects, sessions, configPath } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const initial = plain(await service.connection());
	await service.dispose();
	const restarted = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
	t.after(() => restarted.dispose());
	assert.deepEqual(plain(await restarted.connection()), initial);
	const { client } = await connect(t, restarted);
	assert.equal((await client.callTool({ name: "projects_list" })).structuredContent.data[0].id, "p1");
	await restarted.setAccess({ enabled: false, projectIds: [] });
	await restarted.dispose();
	const stopped = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
	t.after(() => stopped.dispose());
	assert.equal((await stopped.getState()).running, false);
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).token, "");
});

test("corrupt and oversized consent files fail closed without overwriting them", async (t) => {
	const { service, projects, sessions, configPath } = await fixture(t);
	await service.dispose();
	for (const contents of ["{corrupt", " ".repeat(256 * 1024 + 1)]) {
		await writeFile(configPath, contents);
		const broken = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
		try {
			const state = await broken.getState();
			assert.equal(state.running, false);
			assert.equal(state.error, "config-read-failed");
			await assert.rejects(broken.connection(), /service-disabled/);
			assert.equal(await readFile(configPath, "utf8"), contents);
		} finally {
			await broken.dispose();
		}
	}
});

test("port conflict leaves saved consent visible so the user can disable it permanently", async (t) => {
	const { service, projects, sessions, configPath } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const port = new URL((await service.connection()).mcpServers.pideck.url).port;
	await service.dispose();
	const blocker = createServer();
	await new Promise((resolve, reject) => {
		blocker.once("error", reject);
		blocker.listen(Number(port), "127.0.0.1", resolve);
	});
	t.after(() => new Promise((resolve) => blocker.close(resolve)));
	const blocked = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
	t.after(() => blocked.dispose());
	const state = await blocked.getState();
	assert.equal(state.running, false);
	assert.equal(state.enabled, true, "saved authorization must remain visible despite listen failure");
	assert.equal(state.error, "listen-failed");
	await blocked.setAccess({ enabled: false, projectIds: [] });
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, false);
});

test("failed consent persistence closes the newly bound listener and returns a safe error", async (t) => {
	const { service, dir, projects, sessions } = await fixture(t);
	await service.dispose();
	const failed = new PiDeckMcpService({ configPath: dir, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
	t.after(() => failed.dispose());
	await failed.getState();
	await assert.rejects(failed.setAccess({ enabled: true, projectIds: ["p1"] }), /config-write-failed/);
	assert.equal((await failed.getState()).running, false);
	await assert.rejects(failed.connection(), /service-disabled/);
});

test("failed revoke is stopped immediately but keeps saved consent retryable until persisted", async (t) => {
	const { service, configPath } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const backup = `${configPath}.backup`;
	await rename(configPath, backup);
	await mkdir(configPath);
	await assert.rejects(service.setAccess({ enabled: false, projectIds: [] }), /config-write-failed/);
	const state = await service.getState();
	assert.equal(state.running, false);
	assert.equal(state.enabled, true, "saved consent must remain visible for retry");
	await assert.rejects(service.connection(), /service-disabled/);
	await rm(configPath, { recursive: true });
	await rename(backup, configPath);
	await service.setAccess({ enabled: false, projectIds: [] });
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, false);
});

test("revocation requested during initialization wins over persisted enabled state", async (t) => {
	const { service, projects, sessions, configPath } = await fixture(t);
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	await service.dispose();
	const restarted = new PiDeckMcpService({ configPath, projects: () => projects, sessions, settings: () => null, builtInExtensionsVersion: () => null, runtimes: () => [], abortRuntime: async () => ({ ok: true, value: undefined }), warn: () => undefined });
	t.after(() => restarted.dispose());
	const state = await restarted.setAccess({ enabled: false, projectIds: [] });
	assert.equal(state.enabled, false);
	assert.equal(state.running, false);
	assert.equal(JSON.parse(await readFile(configPath, "utf8")).enabled, false);
});

test("disconnected requests keep their IO budget until settled, then release slots", { timeout: 5000 }, async (t) => {
	let entered = 0;
	let allStarted;
	let release;
	const started = new Promise((r) => {
		allStarted = r;
	});
	const work = new Promise((r) => {
		release = r;
	});
	const { service } = await fixture(t, {
		sessions: {
			get: () => ({}),
			list: () => ({}),
			search: () => [],
			entries: () => {
				if (++entered === 4) allStarted();
				return work;
			},
		},
	});
	await service.setAccess({ enabled: true, projectIds: ["p1"] });
	const definition = (await service.connection()).mcpServers.pideck;
	const headers = { ...definition.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	const requests = controllers.map((controller, id) => fetch(definition.url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "sessions_entries", arguments: { projectId: "p1", sessionId: "s1" } } }) }).catch(() => undefined));
	t.after(() => {
		controllers.forEach((c) => c.abort());
		release({ entries: [] });
	});
	await started;
	controllers.forEach((c) => c.abort());
	await Promise.all(requests);
	const list = () => fetch(definition.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }) });
	const busy = await list();
	assert.equal(busy.status, 429, "disconnected readers must not bypass the four-operation IO budget");
	await busy.text();
	release({ entries: [] });
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	const recovered = await list();
	assert.equal(recovered.status, 200, "SDK shutdown must not strand completed request slots");
	assert.equal((await recovered.json()).result.tools.length, 8);
});

test("通配授权跟随项目列表：新增项目立即可读，已删除项目当场失效", async (t) => {
	const { service, projects } = await fixture(t);
	// 白名单为空也能启用：授权从「保存时的快照」改成「请求时求值」，所以列表可以为空。
	await service.setAccess({ enabled: true, projectIds: [], allProjects: true, allowControl: false });
	const { client, definition } = await connect(t, service);
	assert.deepEqual((await client.callTool({ name: "projects_list" })).structuredContent.data, [
		{ id: "p1", name: "Allowed" },
		{ id: "p2", name: "Private" },
	]);
	// 用户新建工作区后不需要再点「应用」（也就不会轮换令牌），旧连接继续能用。
	projects.push({ id: "p3", name: "Fresh" });
	assert.equal((await client.callTool({ name: "sessions_list", arguments: { projectId: "p3" } })).isError, undefined);
	assert.equal((await service.connection()).mcpServers.pideck.url, definition.url);
	// 通配不是「id 永久有效」：项目被删掉后同一个请求当场失效。
	projects.splice(
		projects.findIndex((project) => project.id === "p2"),
		1,
	);
	assert.equal((await client.callTool({ name: "sessions_list", arguments: { projectId: "p2" } })).isError, true);
});

test("通配/写开关字段向后兼容，且 enabled 必须至少有一块可读区域", async (t) => {
	const { readPiDeckMcpConfig } = loadTsCommonJs("src/main/config/piDeckMcpConfig.ts");
	const dir = await mkdtemp(join(tmpdir(), "pideck-mcp-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "mcp-host.json");
	const read = async (config) => {
		await writeFile(path, JSON.stringify(config));
		return readPiDeckMcpConfig(path);
	};
	const base = { version: 1, enabled: true, projectIds: [], allProjects: false, allowControl: false, port: 41234, token: "a".repeat(64) };
	// 旧版本写的文件没有这两个字段：必须原样读成 false，而不是判成损坏或误当通配。
	const legacy = await read({ version: 1, enabled: true, projectIds: ["p1"], port: 41234, token: "a".repeat(64) });
	assert.equal(legacy.allProjects, false);
	assert.equal(legacy.allowControl, false);
	assert.equal(legacy.projectIds[0], "p1");
	// enabled 但既没白名单也不是通配：这份配置谁都不能读，必须 fail closed 而不是静默监听。
	await assert.rejects(read(base), /config-read-failed/);
	// 通配与非空白名单都是合法可读区域。
	assert.equal((await read({ ...base, allProjects: true })).allProjects, true);
	assert.equal((await read({ ...base, projectIds: ["p1"] })).projectIds[0], "p1");
	// 缺 token/port 同样 fail closed：enabled 的配置必须真的能接受请求。
	await assert.rejects(read({ ...base, allProjects: true, token: "" }), /config-read-failed/);
	await assert.rejects(read({ ...base, allProjects: true, port: 0 }), /config-read-failed/);
});

test("写开关只在打开时注册 sessions_abort；中断按代次校验，且不越过项目授权", async (t) => {
	const aborted = [];
	const runtimes = [
		{ sessionId: "s1", agentId: "a1", runtimeGeneration: 3, projectId: "p1", cwd: "/tmp", status: "running", createdAt: 1 },
		// p2 里也有在跑的会话：它必须从 runtime_status 里消失，且不可被中止。
		{ sessionId: "s2", agentId: "a2", runtimeGeneration: 1, projectId: "p2", cwd: "/tmp", status: "running", createdAt: 2 },
	];
	const { service } = await fixture(t, {
		runtimes: () => runtimes,
		abortRuntime: async (target) => {
			aborted.push(plain(target));
			return { ok: true, value: undefined };
		},
	});
	await service.setAccess({ enabled: true, projectIds: ["p1"], allProjects: false, allowControl: false });
	const off = (await connect(t, service)).client;
	// 关着时工具不注册：客户端连看都看不到，而不是注册后再拒绝。
	assert.equal(
		(await off.listTools()).tools.some((tool) => tool.name === "sessions_abort"),
		false,
	);
	assert.equal(
		(await off.listTools()).tools.some((tool) => tool.name === "runtime_status"),
		true,
	);

	await service.setAccess({ enabled: true, projectIds: ["p1"], allProjects: false, allowControl: true });
	const on = (await connect(t, service)).client;
	const write = (await on.listTools()).tools.find((tool) => tool.name === "sessions_abort");
	// readOnlyHint 是客户端决定「要不要弹确认」的依据，写工具绝不能被标成只读。
	assert.equal(write.annotations.readOnlyHint, false);
	assert.equal(write.annotations.destructiveHint, false);
	const call = (name, args = {}) => on.callTool({ name, arguments: args });
	const status = (await call("runtime_status")).structuredContent.data;
	assert.equal(status.authorizedProjectCount, 1);
	assert.deepEqual(
		status.runtimes.map((runtime) => runtime.sessionId),
		["s1"],
	);
	assert.equal(status.runtimes[0].busy, true);
	// 代次必须由 runtime_status 给出，否则客户端无法做乐观并发（这是该字段存在的唯一理由）。
	const generation = status.runtimes[0].runtimeGeneration;
	assert.equal(generation, 3);
	// 乐观并发：调用方看到的是某一代 runtime，重启后 agentId 换人就不能盲停。
	assert.equal((await call("sessions_abort", { sessionId: "s1", expectedRuntimeGeneration: generation + 1 })).isError, true);
	assert.deepEqual(aborted, []);
	// 未授权项目里的会话停在授权这一步，不会落回「没有在跑」那种误导性报错。
	assert.equal((await call("sessions_abort", { sessionId: "s2" })).isError, true);
	assert.equal((await call("sessions_abort", { sessionId: "s1", expectedRuntimeGeneration: generation })).isError, undefined);
	assert.deepEqual(aborted, [{ sessionId: "s1", agentId: "a1", runtimeGeneration: 3 }]);
});
