/**
 * 本地服务能力（`service.local`）的门禁测试。
 *
 * 覆盖四件事：
 *   1. manifest：`service.local` 与 `services` 互为必需，且只能点名 PiDeck 已实现的服务；
 *   2. policy：四个 service 方法只接受白名单 id，其他一律 `invalid-request` / `unsupported-method`；
 *   3. broker：权限 + 点名双重门、适配器缺席时 `service-unavailable`、撤销授权时中断在途启停、
 *      `openUi` 只转发主进程适配器推导出的地址；
 *   4. 适配器自身：只认回环 UI 地址、只按 CLI 报告的 pid 终止、命令与参数过字符白名单。
 *
 * 另外守一份「随包内置示例插件」的契约：它必须是真能装进用户目录的包。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseHostPluginManifest } = loadTsCommonJs("src/main/plugins/hostPluginManifest.ts");
const { parsePluginRequest } = loadTsCommonJs("src/main/plugins/hostPluginPolicy.ts");
const { HostPluginBroker } = loadTsCommonJs("src/main/plugins/HostPluginBroker.ts");
const { HostPluginManager } = loadTsCommonJs("src/main/plugins/HostPluginManager.ts");
const { LocalServiceRegistry } = loadTsCommonJs("src/main/localServices/LocalServiceRegistry.ts");
const { BillionContextService, parseBillionContextReport } = loadTsCommonJs("src/main/localServices/billionContextService.ts");
const { localServiceInvocation, killLocalServiceInvocation } = loadTsCommonJs("src/main/localServices/localServiceCli.ts");
const { LOCAL_SERVICE_IDS, isLocalServiceId } = loadTsCommonJs("src/shared/localServices.ts");

const SERVICE_ID = LOCAL_SERVICE_IDS[0];

/**
 * `loadTsCommonJs` 在 vm 沙箱里求值，生产模块造出来的对象属于另一个 realm，
 * `assert.deepStrictEqual` 会因为原型不同报 “same structure but not reference-equal”。
 * 比较前一律过一遍 JSON 往返（同 `tests/hostPlugins.test.mjs` 的做法）。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function manifest(over = {}) {
	return {
		schemaVersion: 1,
		apiVersion: 1,
		id: "example.viewer",
		name: "Viewer",
		version: "1.0.0",
		permissions: ["service.local"],
		services: [SERVICE_ID],
		contributes: { panels: [{ id: "main", title: "Main", entry: "app.html" }], commands: [] },
		...over,
	};
}

/** broker 只读 manifest.permissions / manifest.services，不重新校验，所以这里给原始对象。 */
const brokerManifest = (permissions, services) => ({ schemaVersion: 1, apiVersion: 1, id: "example.viewer", name: "Viewer", version: "1.0.0", permissions, services, contributes: { panels: [], commands: [] } });
const emptySessions = { list: () => ({ sessions: [], nextOffset: null }), entries: async () => ({ entries: [], nextCursor: null, truncated: false }), describe: (context) => context, navigable: () => false };
const emptyStorage = { get: () => null, set: async () => undefined, keys: async () => [], remove: async () => undefined };
const context = { locale: "zh-CN", theme: "light" };

function brokerFor(permissions, services, registry) {
	// 参数尾部是 (projectNameOf, network, services)；这里只要服务适配器表，其余走缺省。
	return new HostPluginBroker({ getEnabled: (id) => (id === "example.viewer" ? { manifest: brokerManifest(permissions, services), fingerprint: "f" } : undefined), onChanged: () => () => {} }, emptySessions, emptyStorage, undefined, undefined, registry);
}

/** 替身适配器：记录调用顺序，可注入每个方法的行为。 */
function fakeAdapter(over = {}) {
	const calls = [];
	const status = over.status ?? (async () => ({ id: SERVICE_ID, available: true, running: true, pid: 42, uiUrl: "http://127.0.0.1:8788/__bili/" }));
	return {
		calls,
		adapter: {
			id: SERVICE_ID,
			status: async (signal) => {
				calls.push("status");
				return status(signal);
			},
			start: async (signal) => {
				calls.push("start");
				return over.start ? over.start(signal) : { id: SERVICE_ID, available: true, running: true, pid: 42 };
			},
			stop: async () => {
				calls.push("stop");
				return over.stop ? over.stop() : { id: SERVICE_ID, available: true, running: false };
			},
		},
	};
}

test("manifest: service.local and services are mutually required and must name an implemented service", () => {
	assert.deepEqual(plain(parseHostPluginManifest(manifest()).services), [SERVICE_ID]);
	// 只声明权限不点名服务 → 拒
	assert.throws(() => parseHostPluginManifest(manifest({ services: undefined })), /invalid-services/);
	// 点名了 PiDeck 没实现的服务 → 拒（第三方插件无法自行扩展能力面）
	assert.throws(() => parseHostPluginManifest(manifest({ services: ["some-other-service"] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: [SERVICE_ID, SERVICE_ID] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: [] })), /invalid-services/);
	assert.throws(() => parseHostPluginManifest(manifest({ services: Array.from({ length: 9 }, () => SERVICE_ID) })), /invalid-services/);
	// 反过来：没有 service.local 权限却写 services → 同样拒
	assert.throws(() => parseHostPluginManifest(manifest({ permissions: ["sessions.read"] })), /invalid-services/);
	// 不涉及服务时不受影响
	const parsed = parseHostPluginManifest(manifest({ permissions: ["sessions.read"], services: undefined }));
	assert.equal(parsed.services, undefined);
	assert.equal(isLocalServiceId(SERVICE_ID), true);
	assert.equal(isLocalServiceId("billion-contexts"), false);
});

test("policy: service methods accept only allowlisted ids and reject unknown methods", () => {
	for (const method of ["service.status", "service.start", "service.stop", "service.openUi"]) {
		assert.deepEqual(plain(parsePluginRequest({ method, id: SERVICE_ID })), { method, id: SERVICE_ID });
	}
	assert.throws(() => parsePluginRequest({ method: "service.start", id: "billion-context; rm -rf /" }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ method: "service.start", id: "" }), /invalid-request/);
	assert.throws(() => parsePluginRequest({ method: "service.start" }), /invalid-request/);
	// 只有登记过的方法存在：新增方法忘登记会报错，而不是白拿权限。
	assert.throws(() => parsePluginRequest({ method: "service.install", id: SERVICE_ID }), /unsupported-method/);
});

test("broker: service control requires both the permission and the named service", async () => {
	const { adapter, calls } = fakeAdapter();
	const registry = new LocalServiceRegistry([adapter]);

	const allowed = brokerFor(["service.local"], [SERVICE_ID], registry);
	allowed.bind(1, "example.viewer", "f", context);
	assert.equal((await allowed.request(1, true, { method: "service.status", id: SERVICE_ID })).ok, true);
	assert.deepEqual(calls, ["status"]);

	// 有权限但没点名这个服务 → permission-denied，适配器一次都不该被碰
	const undeclared = brokerFor(["service.local"], [], registry);
	undeclared.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await undeclared.request(1, true, { method: "service.status", id: SERVICE_ID })), { ok: false, code: "permission-denied" });
	assert.deepEqual(calls, ["status"]);

	// 点名了但没有权限 → permission-denied
	const unpermitted = brokerFor(["sessions.read"], [SERVICE_ID], registry);
	unpermitted.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await unpermitted.request(1, true, { method: "service.start", id: SERVICE_ID })), { ok: false, code: "permission-denied" });

	// 白名单里有、但本机没装适配器 → service-unavailable（白名单与适配器装配是两件事）
	const missing = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([]));
	missing.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await missing.request(1, true, { method: "service.status", id: SERVICE_ID })), { ok: false, code: "service-unavailable" });

	for (const broker of [allowed, undeclared, unpermitted, missing]) broker.dispose();
});

test("broker: openUi forwards the adapter-derived url and refuses a stopped service", async () => {
	const running = fakeAdapter();
	const opened = [];
	const broker = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([running.adapter]));
	broker.onOpenBrowser((url) => opened.push(url));
	broker.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await broker.request(1, true, { method: "service.openUi", id: SERVICE_ID })), { ok: true, value: null });
	// 插件只能要求「打开」，地址一律来自主进程适配器。
	assert.deepEqual(opened, ["http://127.0.0.1:8788/__bili/"]);

	const stopped = fakeAdapter({ status: async () => ({ id: SERVICE_ID, available: true, running: false }) });
	const broker2 = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([stopped.adapter]));
	const opened2 = [];
	broker2.onOpenBrowser((url) => opened2.push(url));
	broker2.bind(1, "example.viewer", "f", context);
	assert.deepEqual(plain(await broker2.request(1, true, { method: "service.openUi", id: SERVICE_ID })), { ok: false, code: "service-not-running" });
	assert.deepEqual(opened2, []);

	broker.dispose();
	broker2.dispose();
});

test("broker: revoking the plugin aborts an in-flight start and voids its result", async () => {
	let released;
	const started = new Promise((resolve) => {
		released = resolve;
	});
	const { adapter } = fakeAdapter({
		start: async (signal) => {
			// 启停要等进程真的起来：这里模拟「还在等」的服务，撤销授权必须立刻中断。
			await new Promise((done) => {
				signal.addEventListener("abort", () => done(), { once: true });
				void started.then(() => done());
			});
			return { id: SERVICE_ID, available: true, running: true, pid: 42 };
		},
	});
	const broker = brokerFor(["service.local"], [SERVICE_ID], new LocalServiceRegistry([adapter]));
	broker.bind(1, "example.viewer", "f", context);
	const pending = broker.request(1, true, { method: "service.start", id: SERVICE_ID });
	broker.unbind(1);
	released();
	assert.deepEqual(plain(await pending), { ok: false, code: "plugin-revoked" });
	broker.dispose();
});

test("billion-context report: only loopback origins with a live pid count as running", () => {
	const report = (processes, global) => JSON.stringify({ processes, global });
	const live = { instanceId: "i", pid: 23704, port: 28800, origin: "http://127.0.0.1:28800", alive: true };
	assert.deepEqual(plain(parseBillionContextReport(report([live], { runningVersion: "0.1.195" }))), { running: true, pid: 23704, origin: "http://127.0.0.1:28800", version: "0.1.195" });
	// 没有 origin 但有 pid + port：origin 由 port 推导
	assert.equal(parseBillionContextReport(report([{ pid: 7, port: 8788, alive: true }], {})).origin, "http://127.0.0.1:8788");
	// 报告被改写成公网地址 → 不当成可用（否则会把内置浏览器带走）
	assert.deepEqual(plain(parseBillionContextReport(report([{ pid: 7, port: 8788, origin: "http://evil.example.com:8788", alive: true }], {}))), { running: false });
	assert.deepEqual(plain(parseBillionContextReport(report([{ pid: 7, port: 8788, origin: "https://127.0.0.1:8788", alive: true }], {}))), { running: false });
	// alive:false / 缺 pid 的条目不算运行
	assert.deepEqual(plain(parseBillionContextReport(report([{ ...live, alive: false }], {}))), { running: false });
	assert.deepEqual(plain(parseBillionContextReport(report([{ port: 8788, alive: true }], {}))), { running: false });
	// 报告本身不可解析（区别于「装了但没跑」）
	assert.equal(parseBillionContextReport("not json"), null);
	assert.equal(parseBillionContextReport("[]"), null);
});

test("billion-context service: status, start and stop all go through the fixed CLI commands", async () => {
	const record = [];
	const cli = (report) => ({ run: async (args) => (record.push(["run", ...args]), { ok: true, stdout: typeof report === "function" ? report(args) : report }), spawnDetached: (args) => (record.push(["spawn", ...args]), { ok: true }) });
	const kill = async (pid) => (record.push(["kill", pid]), true);
	const running = JSON.stringify({ processes: [{ pid: 23704, port: 28800, alive: true }], global: { runningVersion: "0.1.195" } });
	const stopped = JSON.stringify({ processes: [], global: { runningVersion: "0.1.195" } });

	const service = new BillionContextService({ cli: cli(running), kill });
	assert.deepEqual(plain(await service.status()), { id: SERVICE_ID, available: true, running: true, pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/", version: "0.1.195" });
	assert.deepEqual(record, [["run", "doctor", "--json"]]);

	// 未运行 → 先起进程，再轮询到 doctor 报告存活；命令固定为 `bili start`
	record.length = 0;
	let calls = 0;
	const starting = new BillionContextService({ cli: cli(() => (++calls === 1 ? stopped : running)), kill });
	assert.deepEqual(plain(await starting.start()), { id: SERVICE_ID, available: true, running: true, pid: 23704, uiUrl: "http://127.0.0.1:28800/__bili/", version: "0.1.195" });
	assert.deepEqual(record, [
		["run", "doctor", "--json"],
		["spawn", "start"],
		["run", "doctor", "--json"],
	]);

	// 停止：pid 只来自报告，不猜
	record.length = 0;
	assert.deepEqual(plain(await new BillionContextService({ cli: cli(() => (++calls > 3 ? stopped : running)), kill }).stop()), { id: SERVICE_ID, available: true, running: false, version: "0.1.195" });
	assert.deepEqual(record, [
		["run", "doctor", "--json"],
		["kill", 23704],
		["run", "doctor", "--json"],
	]);

	// CLI 不可用 → available:false 且带原因码；未运行时不发 kill
	const missing = new BillionContextService({ cli: { run: async () => ({ ok: false, reason: "cli-missing" }), spawnDetached: () => ({ ok: true }) }, kill });
	assert.deepEqual(plain(await missing.status()), { id: SERVICE_ID, available: false, running: false, reason: "cli-missing" });
	assert.deepEqual(plain(await missing.stop()), { id: SERVICE_ID, available: false, running: false });
});

test("billion-context service: a service that never comes up reports start-timeout instead of hanging", async () => {
	const stopped = JSON.stringify({ processes: [], global: {} });
	let calls = 0;
	const controller = new AbortController();
	// 第 2 次 doctor 时中断（等价于插件被撤销授权）：轮询必须立刻收手，而不是等满 20 秒预算。
	const service = new BillionContextService({
		cli: {
			run: async () => {
				calls += 1;
				if (calls >= 2) controller.abort();
				return { ok: true, stdout: stopped };
			},
			spawnDetached: () => ({ ok: true }),
		},
		kill: async () => true,
	});
	assert.deepEqual(plain(await service.start(controller.signal)), { id: SERVICE_ID, available: true, running: false, reason: "start-timeout" });
});

test("local service cli: commands and arguments are character-allowlisted, never interpolated", () => {
	const invocation = localServiceInvocation("bili", ["doctor", "--json"]);
	assert.equal(invocation.args.at(-1).includes("doctor --json"), true);
	// Windows 上 npm 全局命令是 .cmd 垫片，必须经 cmd.exe；其他平台原样透传。
	assert.equal(process.platform === "win32" ? invocation.command === (process.env.ComSpec || "cmd.exe") && invocation.windowsVerbatimArguments === true : invocation.command === "bili" && invocation.args.length === 2, true);
	assert.doesNotThrow(() => localServiceInvocation("bili", ["start", "--port=8788", "-F"]));
	assert.throws(() => localServiceInvocation("bili; rm -rf /", []), /invalid-service-command/);
	assert.throws(() => localServiceInvocation("bili && curl evil.example.com", []), /invalid-service-command/);
	assert.throws(() => localServiceInvocation("bili", ["$(whoami)"]), /invalid-service-argument/);
	assert.throws(() => localServiceInvocation("bili", ["start | tee /tmp/x"]), /invalid-service-argument/);
	assert.throws(() => localServiceInvocation("bili", ["a".repeat(200)]), /invalid-service-argument/);
	// 终止：参数永远是数组，Windows 走 taskkill 真 exe（不经 cmd.exe、不拼 shell 字符串）。
	assert.deepEqual(plain(killLocalServiceInvocation(23704, "win32")), { command: "taskkill", args: ["/pid", "23704", "/t", "/f"] });
	assert.deepEqual(plain(killLocalServiceInvocation(23704, "linux")), { command: "kill", args: ["-TERM", "23704"] });
	// 非法 pid 直接拒绝，不发命令
	for (const pid of [0, -1, 1.5, 2 ** 31, Number.NaN]) assert.equal(killLocalServiceInvocation(pid, "win32"), null, String(pid));
});

test("seedBuiltin places the packaged demo plugin once and never overwrites it", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-host-plugins-"));
	try {
		const source = join(root, "resources");
		const plugin = join(source, SERVICE_ID);
		await mkdir(plugin, { recursive: true });
		await writeFile(join(plugin, "pideck-plugin.json"), JSON.stringify(manifest({ id: SERVICE_ID, name: "billion-context", permissions: ["service.local"], services: [SERVICE_ID] })));
		await writeFile(join(plugin, "app.html"), "<!doctype html>");
		await writeFile(join(plugin, "app.js"), "console.log('shipped');");

		const manager = new HostPluginManager(join(root, "userData"));
		await manager.seedBuiltin(source);
		const target = join(root, "userData", "host-plugins", SERVICE_ID);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('shipped');");
		// seedBuiltin 只负责落位，扫描仍由 load()/rescan() 触发
		await manager.load();
		assert.equal(manager.catalog().plugins.length, 1);
		// 落位不等于授权：内置插件同样是 requiresConsent。
		assert.equal(manager.catalog().plugins[0].requiresConsent, true);

		// 用户改过的副本永不被覆盖
		await writeFile(join(target, "app.js"), "console.log('mine');");
		await manager.seedBuiltin(source);
		assert.equal(await readFile(join(target, "app.js"), "utf8"), "console.log('mine');");

		// 源目录不存在（打包漏配 extraResources）只是少一个示例，不该抛
		await assert.doesNotReject(() => manager.seedBuiltin(join(root, "absent")));
		manager.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the packaged billion-context demo is a loadable package that only talks to window.pideck", async () => {
	const directory = join("resources", "host-plugins", SERVICE_ID);
	const packaged = parseHostPluginManifest(JSON.parse(await readFile(join(directory, "pideck-plugin.json"), "utf8")));
	assert.equal(packaged.id, SERVICE_ID);
	assert.deepEqual(plain(packaged.permissions), ["service.local"]);
	assert.deepEqual(plain(packaged.services), [SERVICE_ID]);
	for (const file of ["app.html", "app.js", "styles.css", "README.md"]) assert.ok((await stat(join(directory, file))).size > 0, `${file} 不该是空文件`);
	const app = await readFile(join(directory, "app.js"), "utf8");
	assert.match(app, /pideck\.services\.(status|start|stop|openUi)/);
	// 面板 CSP 是 connect-src 'none'：不能 fetch、不能内嵌、不能引 CDN，能力只走 window.pideck。
	assert.doesNotMatch(app, /\bfetch\(|XMLHttpRequest|innerHTML|importScripts|https?:\/\/(?!127\.0\.0\.1)/);
	assert.doesNotMatch(await readFile(join(directory, "app.html"), "utf8"), /<script[^>]*src="https?:/);
});
