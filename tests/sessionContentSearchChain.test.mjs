/**
 * 跨会话正文搜索（sessions:search-content）的链路契约测试。
 *
 * IPC 三处同步（通道常量 / main handler / preload 白名单）漏一处就是运行时
 * undefined，渲染层静默拿不到结果——用源码扫描把整条链路的接点钉住：
 * shared 通道定义、sessionIpc 边界校验（非字符串/空/超长/catch 一律 null）、
 * preload 暴露、previewApi 降级 stub、渲染层挂载与 pendingMessageJump 消费。
 * 正则全部空白容忍（biome 重排格式不破坏断言）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");

test("shared/ipc.ts：通道常量 sessions:search-content 已定义", () => {
	const source = read("../src/shared/ipc.ts");
	assert.match(source, /sessionsSearchContent:\s*["']sessions:search-content["']/);
});

test("sessionIpc.ts：handler 注册 + 边界校验（非字符串/空/超长/catch 一律 null）", () => {
	const source = read("../src/main/ipc/sessionIpc.ts");
	assert.match(source, /ipcMain\.handle\(ipcChannels\.sessionsSearchContent/);
	assert.match(source, /typeof\s+query\s+!==\s*["']string["']\s*\)\s*return\s+null/);
	assert.match(source, /!trimmed\s*\|\|\s*trimmed\.length\s*>\s*256\s*\)\s*return\s+null/);
	// 渲染层数据不可信：searcher 抛错必须吞掉返回 null，不允许错误跨 IPC
	assert.match(source, /return\s+null;\s*\}\s*\}\);/);
});

test("preload/index.ts：sessions.searchContent 暴露在白名单", () => {
	const source = read("../src/preload/index.ts");
	assert.match(source, /searchContent:\s*\(query:\s*string\)/);
	assert.match(source, /sessionsSearchContent/);
});

test("previewApi.ts：预览模式降级 stub 返回 null", () => {
	const source = read("../src/renderer/src/previewApi.ts");
	assert.match(source, /searchContent:\s*async\s*\(\)\s*=>\s*null/);
});

test("SidebarContent.tsx：搜索词非空时挂载 SessionContentSearchResults", () => {
	const source = read("../src/renderer/src/components/sidebar/SidebarContent.tsx");
	assert.match(source, /import\s*\{\s*SessionContentSearchResults\s*\}\s*from\s*["']\.\/SessionContentSearchResults["']/);
	assert.match(source, /<SessionContentSearchResults/);
});

test("ChatSessionPane.tsx：pendingMessageJump 聚焦消费（消息未就绪时保留重试）", () => {
	const source = read("../src/renderer/src/components/session/ChatSessionPane.tsx");
	assert.match(source, /useSetAtom\(pendingMessageJumpAtom\)/);
	// 消息未加载完不消费：等 jumpToMessage 引用随消息更新重触发，避免跳转丢失
	assert.match(source, /sessionTimeline\.messages\.length\s*===\s*0\s*&&\s*!sessionTimeline\.knownEmpty/);
	assert.match(source, /sessionTimeline\.jumpToMessage\(pendingJump\.messageId\)/);
});

test("session-atoms.ts：pendingMessageJumpAtom 存在且初始 null", () => {
	const source = read("../src/renderer/src/atoms/session-atoms.ts");
	assert.match(source, /export\s+const\s+pendingMessageJumpAtom\s*=\s*atom<\{\s*sessionId:\s*string;\s*messageId:\s*string\s*\}\s*\|\s*null>\(null\)/);
});
