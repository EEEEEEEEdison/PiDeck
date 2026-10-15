/**
 * F8 · preload 暴露面快照守卫（TEST-PLAN §F8，6 例=4 正+2 负）。
 *
 * 捕获 src/preload/index.ts 经 contextBridge 实际暴露的 piDesktop API，对
 * 70 命名空间清单与每命名空间方法清单做 sha256 快照（A10：暴露面零变化），
 * 并核对数量锚点（sessions 110 / config 48 / git 38 / app 32）与订阅形态。
 * 摘要来源：T7 只读探针实测（2026-10-14；2026-10-16 合并刷新随 dev 演进重算）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NS_LIST_SHA256 = "5f3768123e04385116d679b8b3e6f16b638a84657c46d036d18faa9fb57ae804";
const FULL_METHODS_SHA256 = "a6a0b4b2aca14e5a30cca5ec1e580b98a7a107413cdf3a946aec646f359f3a9c";
const NAMESPACE_COUNT = 70;

/** 捕获 preload 暴露的 piDesktop；null/undefined/形态不符时显式红并给诊断（F8-6 共用）。 */
function assertValidCapture(capture) {
	if (capture === null || capture === undefined) {
		throw new Error(`preload 捕获失败: capture=${String(capture)}（electron stub 未收到 exposeInMainWorld 调用，preload 顶层可能已抛错或被跳过）`);
	}
	if (typeof capture !== "object" || capture.name !== "piDesktop" || typeof capture.api !== "object" || capture.api === null) {
		throw new Error(`preload 捕获失败: 捕获物形态不符（name=${String(capture?.name)}），应 exposeInMainWorld("piDesktop", api)`);
	}
	return capture;
}

function capturePreloadApi() {
	let captured = null;
	const electronStub = {
		contextBridge: { exposeInMainWorld: (name, api) => (captured = { name, api }) },
		ipcRenderer: { invoke: () => {}, on: () => () => {}, once: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => ({}) },
		webUtils: { getPathForFile: () => "" },
	};
	const preloadMod = loadTsCommonJs("src/preload/index.ts", { stubs: { electron: electronStub } });
	captured = preloadMod.__pideckPreloadCapture ?? captured;
	return assertValidCapture(captured).api;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sortedKeys = (obj) => Object.keys(obj).sort();

const api = capturePreloadApi();
const namespaces = sortedKeys(api);
const methodLines = namespaces.map((ns) => `${ns}=${sortedKeys(api[ns]).join(",")}`);

test("F8-1 preload 顶层命名空间数 === 70 且排序清单摘要零漂移", () => {
	assert.equal(namespaces.length, NAMESPACE_COUNT, `命名空间数 ${namespaces.length} ≠ ${NAMESPACE_COUNT}`);
	assert.equal(sha256(namespaces.join(",")), NS_LIST_SHA256, "命名空间清单摘要漂移：preload 暴露面发生变化（A10 红线）");
});

test("F8-2 每命名空间排序方法清单摘要零漂移", () => {
	assert.equal(sha256(methodLines.join(";")), FULL_METHODS_SHA256, "方法清单摘要漂移：任一命名空间的方法暴露面发生变化（A10 红线）");
});

test("F8-3 数量锚点：sessions 110 / config 48 / git 38 / app 32", () => {
	assert.equal(Object.keys(api.sessions).length, 110, "sessions 方法数漂移");
	assert.equal(Object.keys(api.config).length, 48, "config 方法数漂移");
	assert.equal(Object.keys(api.git).length, 38, "git 方法数漂移");
	assert.equal(Object.keys(api.app).length, 32, "app 方法数漂移");
});

test("F8-4 订阅形态：全部 on* 方法调用返回退订函数", () => {
	const subscriptionNames = [];
	for (const ns of namespaces) {
		for (const method of Object.keys(api[ns])) {
			// 只认 on* 前缀：watch* 里 git.watchRefs 是返回 Promise<string> 的 watch 句柄请求（配对 unwatchRefs），不是事件订阅。
			if (/^on[A-Z]/.test(method)) subscriptionNames.push(`${ns}.${method}`);
		}
	}
	assert.ok(subscriptionNames.length >= 40, `订阅方法数 ${subscriptionNames.length} 异常缩水`);
	for (const qualified of subscriptionNames) {
		const [ns, method] = qualified.split(".");
		const unsubscribe = api[ns][method](() => {});
		assert.equal(typeof unsubscribe, "function", `${qualified} 必须返回退订函数`);
	}
});

test("F8-5[负] 摘要灵敏度：任一命名空间/方法变动必破 F8-1/F8-2 摘要", () => {
	const droppedNs = namespaces.slice(1);
	assert.notEqual(sha256(droppedNs.join(",")), NS_LIST_SHA256, "删任一命名空间后摘要必须变化");
	const tampered = methodLines.slice();
	tampered[0] = tampered[0].split("=")[0] + "=" + sortedKeys(api[namespaces[0]]).slice(1).join(",");
	assert.notEqual(sha256(tampered.join(";")), FULL_METHODS_SHA256, "删任一方法后摘要必须变化");
	const renamed = methodLines.map((line, index) => (index === 0 ? line.replace("=", "=rogueExtra,") : line));
	assert.notEqual(sha256(renamed.join(";")), FULL_METHODS_SHA256, "增任一方法后摘要必须变化");
});

test("F8-6[负] 捕获物 null/undefined/形态不符 → 显式红并诊断", () => {
	assert.throws(() => assertValidCapture(null), /preload 捕获失败: capture=null/);
	assert.throws(() => assertValidCapture(undefined), /preload 捕获失败: capture=undefined/);
	assert.throws(() => assertValidCapture({ name: "other", api: {} }), /preload 捕获失败: 捕获物形态不符/);
	assert.throws(() => assertValidCapture({ name: "piDesktop" }), /preload 捕获失败: 捕获物形态不符/);
	assert.equal(assertValidCapture({ name: "piDesktop", api: { a: {} } }).name, "piDesktop");
});
