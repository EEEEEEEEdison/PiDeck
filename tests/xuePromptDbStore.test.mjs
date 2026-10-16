/**
 * XuePromptDbStore（提示词库 db 远程拉取 + 缓存）回归测试。
 *
 * 覆盖 #2 远程化核心语义：无缓存首下载落盘、TTL 节流（二次调用零网络）、
 * sha 同版本免下载、sha 变化换新缓存文件并清旧、sha 校验失败换源、
 * repo 副本兜底、网络失败不降级已有缓存。全部经注入 fetchImpl + 临时目录，
 * 不碰真实网络与真实 userData。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { XuePromptDbStore } = loadTsCommonJs("src/main/prompts/XuePromptDbStore.ts");

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** 流式 Response（分块推送，content-length 不可伪造故 totalBytes 为 null——与真实下载的未知长度分支一致）。 */
function streamResponse(bytes) {
	const buffer = Buffer.from(bytes);
	const body = new ReadableStream({
		start(controller) {
			// 分两块推送，驱动 receivedBytes 累加路径
			const half = Math.max(1, Math.floor(buffer.byteLength / 2));
			controller.enqueue(buffer.subarray(0, half));
			controller.enqueue(buffer.subarray(half));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

function textResponse(text) {
	return new Response(text, { status: 200 });
}

function errorResponse() {
	return new Response("gone", { status: 404 });
}

/**
 * fetch stub：按 URL 后缀与源序分发。
 * handler(shaUrl, dbUrl, sourceIndex) 返回 { sha: () => Response, db: () => Response }。
 */
function createFetchRouter(perSource) {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		const isSha = url.endsWith(".sha256");
		const index = url.includes("atomgit") ? 0 : url.includes("github") ? 1 : -1;
		const source = perSource[index] ?? {};
		const responder = isSha ? source.sha : source.db;
		if (!responder) return errorResponse();
		return responder();
	};
	return { fetchImpl, calls, dbFetchCount: () => calls.filter((u) => !u.endsWith(".sha256")).length, shaFetchCount: () => calls.filter((u) => u.endsWith(".sha256")).length };
}

function createStore({ userDataDir, fetchImpl, repoDir = null, onStateChange } = {}) {
	let nowMs = 1000;
	const states = [];
	const store = new XuePromptDbStore({
		userDataDir,
		repoResourceDir: () => repoDir,
		fetchImpl,
		log: () => {},
		onStateChange: (state) => states.push(state),
		// TTL/超时显式给小值，配合注入时钟精确控制节流窗口
		checkTtlMs: 10_000,
		fetchTimeoutMs: 5_000,
		now: () => nowMs,
	});
	return { store, states, advance: (ms) => (nowMs += ms) };
}

test("无缓存无副本：首下载落盘、状态推送下载进度与 ready", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("fake-xueprompts-db-v1");
	const shaV1 = sha256Hex(dbV1);
	const router = createFetchRouter([{ sha: () => textResponse(`${shaV1}  xueprompts.db\n`), db: () => streamResponse(dbV1) }]);
	const { store, states } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });

	const state = await store.ensureReady();
	assert.equal(state.state, "ready");
	assert.equal(state.source, "cache");
	assert.ok(state.path.includes(shaV1.slice(0, 16)));
	assert.ok(existsSync(state.path));
	assert.equal(readFileSync(state.path).toString(), "fake-xueprompts-db-v1");
	// 状态流：下载进度（至少一帧 downloading）→ ready
	assert.ok(states.some((s) => s.state === "downloading" && s.receivedBytes > 0));
	assert.equal(states.at(-1).state, "ready");
});

test("TTL 内二次 ensureReady 零网络；TTL 过期且 sha 同版本 → 只查 sha 免下载", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("v1");
	const shaV1 = sha256Hex(dbV1);
	const router = createFetchRouter([{ sha: () => textResponse(shaV1), db: () => streamResponse(dbV1) }]);
	const { store, advance } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });
	await store.ensureReady();
	const fetchesAfterFirst = router.calls.length;

	// TTL 内：零网络
	const again = await store.ensureReady();
	assert.equal(again.state, "ready");
	assert.equal(router.calls.length, fetchesAfterFirst);

	// TTL 过期 + sha 一致：只多一次 sha 请求（首轮下载 1 次 + 过期重查 1 次），无 db 下载
	advance(60_000);
	const refreshed = await store.ensureReady();
	assert.equal(refreshed.state, "ready");
	assert.equal(router.shaFetchCount(), 2);
	assert.equal(router.dbFetchCount(), 1);
});

test("sha 变化：下载新版本落新文件、旧版本被清理", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("version-one");
	const dbV2 = Buffer.from("version-two-longer");
	let currentDb = dbV1;
	const router = createFetchRouter([
		{
			sha: () => textResponse(sha256Hex(currentDb)),
			db: () => streamResponse(currentDb),
		},
	]);
	const { store, advance } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });
	const first = await store.ensureReady();
	assert.ok(first.path.includes(sha256Hex(dbV1).slice(0, 16)));

	currentDb = dbV2;
	advance(60_000);
	const second = await store.ensureReady();
	assert.equal(second.state, "ready");
	assert.ok(second.path.includes(sha256Hex(dbV2).slice(0, 16)));
	assert.notEqual(second.path, first.path);
	// 旧版本文件被清理，缓存目录只剩当前版本
	const files = readdirSync(join(root, "xue")).filter((n) => n.endsWith(".db"));
	assert.deepEqual(files, [`xueprompts-${sha256Hex(dbV2).slice(0, 16)}.db`]);
});

test("sha 校验失败：第一源作废换第二源，成功落盘", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("real-content");
	const shaV1 = sha256Hex(dbV1);
	const router = createFetchRouter([
		{ sha: () => textResponse(shaV1), db: () => streamResponse(Buffer.from("tampered-or-truncated")) }, // 指纹不符
		{ sha: () => textResponse(shaV1), db: () => streamResponse(dbV1) }, // GitHub 兜底成功
	]);
	const { store } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });
	const state = await store.ensureReady();
	assert.equal(state.state, "ready");
	assert.ok(state.path.includes(shaV1.slice(0, 16)));
});

test("无任何本地副本且全源失败：进入 failed；retry 成功后恢复", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("later-ok");
	const shaV1 = sha256Hex(dbV1);
	let upstreamOk = false;
	const router = createFetchRouter([
		{ sha: () => (upstreamOk ? textResponse(shaV1) : errorResponse()), db: () => streamResponse(dbV1) },
		{ sha: () => errorResponse(), db: () => streamResponse(dbV1) }, // 第二源始终失败
	]);
	const { store, states } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });

	const failed = await store.ensureReady();
	assert.equal(failed.state, "failed");
	assert.equal(states.at(-1).state, "failed");

	upstreamOk = true;
	const recovered = await store.retry();
	assert.equal(recovered.state, "ready");
	assert.ok(existsSync(recovered.path));
});

test("repo 副本可用：立即 ready(source=repo)，网络失败不阻塞商店", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	const repoDir = mkdtempSync(join(tmpdir(), "xue-repo-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(repoDir, { recursive: true, force: true });
	});
	writeFileSync(join(repoDir, "xueprompts.db"), Buffer.from("repo-copy"));
	const router = createFetchRouter([{ sha: () => errorResponse() }, { sha: () => errorResponse() }]);
	const { store } = createStore({ userDataDir: root, repoDir, fetchImpl: router.fetchImpl });

	const state = await store.ensureReady();
	assert.equal(state.state, "ready");
	assert.equal(state.source, "repo");
	assert.equal(readFileSync(state.path).toString(), "repo-copy");
});

test("已有缓存时网络全败：继续用缓存不降级", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "xue-db-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dbV1 = Buffer.from("cached-v1");
	const shaV1 = sha256Hex(dbV1);
	let upstreamOk = true;
	const router = createFetchRouter([{ sha: () => (upstreamOk ? textResponse(shaV1) : errorResponse()), db: () => streamResponse(dbV1) }, { sha: () => errorResponse() }]);
	const { store, advance } = createStore({ userDataDir: root, fetchImpl: router.fetchImpl });
	await store.ensureReady();

	upstreamOk = false;
	advance(60_000);
	const state = await store.ensureReady();
	assert.equal(state.state, "ready");
	assert.equal(state.source, "cache");
	assert.ok(existsSync(state.path));
});
