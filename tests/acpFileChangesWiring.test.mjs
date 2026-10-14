import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 审计发现 I 的回归：「修改的文件」横栏对 ACP 会话的取数接线。
 *
 * 行为面：ACP 工具卡片（AcpEventProjector 产出 meta.toolName + meta.args=rawInput）
 * 必须能被 shared/fileChanges 聚合出 SessionFileChange——否则 sessionIpc 的 ACP 分支
 * 接了也是空转。
 * 源码面：sessionsListFileChanges（桌面 sessionIpc + Web 预览装配）必须先走 ACP 分支
 * （运行时投影聚合），再落回无 filePath 的空数组早退——顺序错了 ACP 会话永远空横栏。
 */

test("ACP 工具卡片消息可被 collectLatestTurnFileChanges 聚合（meta.toolName/meta.args 契约）", () => {
	const { collectLatestTurnFileChanges } = loadTsCommonJs("src/shared/fileChanges.ts");
	const user = { role: "user", text: "改一下" };
	const acpEdit = { role: "assistant", text: "edit", meta: { toolName: "edit", toolCallId: "t1", args: { filePath: "C:/repo/a.ts", oldText: "a", newText: "b" } } };
	const acpWrite = { role: "assistant", text: "write", meta: { toolName: "write", toolCallId: "t2", args: { filePath: "C:/repo/new.ts", content: "hi" } } };
	const entries = collectLatestTurnFileChanges([user, acpEdit, acpWrite]);
	assert.equal(entries.length, 2);
	assert.deepEqual([...entries.map((entry) => entry.path)], ["C:/repo/a.ts", "C:/repo/new.ts"]);
	assert.equal(entries[0].originalContent, "a");
	assert.equal(entries[0].content, "b");
});

test("sessionsListFileChanges：桌面 handler ACP 分支先于无 filePath 早退", () => {
	const source = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	const handler = source.slice(source.indexOf("ipcChannels.sessionsListFileChanges"));
	const acpBranch = handler.indexOf('entry?.backend === "acp"');
	const earlyReturn = handler.indexOf("!entry?.filePath");
	assert.ok(acpBranch > 0, "handler 必须有 ACP 分支");
	assert.ok(earlyReturn > acpBranch, "ACP 分支必须先于无 filePath 早退（ACP 无会话文件）");
	assert.ok(handler.slice(acpBranch, acpBranch + 200).includes("collectLatestTurnFileChanges"), "ACP 分支按最新一轮口径聚合");
	assert.ok(handler.slice(acpBranch, acpBranch + 260).includes("readAcpMessages"), "ACP 分支从运行时消息投影取数");
});

test("sessionsListFileChanges：Web 预览装配同样带 ACP 分支", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	const wiring = source.slice(source.indexOf("listSessionFileChanges: (sessionId)"));
	const acpBranch = wiring.indexOf('entry?.backend === "acp"');
	const earlyReturn = wiring.indexOf("!entry?.filePath");
	assert.ok(acpBranch > 0, "Web 装配必须有 ACP 分支");
	assert.ok(earlyReturn > acpBranch, "ACP 分支必须先于无 filePath 早退");
	assert.ok(wiring.slice(acpBranch, acpBranch + 260).includes("readMessagesByAcpSessionId"), "Web 装配从 acpAgentManager 运行时投影取数");
});
