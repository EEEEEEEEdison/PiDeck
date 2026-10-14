/** 未激活 ACP 会话「历史恢复提示」的判定（utils/acpSessionRestore 纯函数单测）。 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveAcpRestoreHint } = loadTsCommonJs("src/renderer/src/utils/acpSessionRestore.ts");

const TOOLS = [
	{ id: "t-gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"], enabled: true },
	{ id: "t-codex", name: "Codex CLI", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"], enabled: true },
];

test("未激活 + acpSessionId + 工具在表：显示恢复提示（带工具名）", () => {
	const hint = resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, undefined, TOOLS);
	assert.equal(hint.kind, "restore");
	assert.equal(hint.toolName, "Gemini CLI");
});

test("新草稿（无 acpSessionId）不显示：没有可恢复的历史", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpToolId: "t-gemini" }, undefined, TOOLS), undefined);
});

test("已激活会话不显示：历史已重放进时间线", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gemini" }, "acp:agent-1", TOOLS), undefined);
});

test("pi/dsh 等其他后端不显示", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "pi", acpSessionId: "x" }, undefined, TOOLS), undefined);
	assert.equal(resolveAcpRestoreHint({ backend: "dsh", acpSessionId: "x" }, undefined, TOOLS), undefined);
});

test("绑定工具被删 → 只读降级引导（不发恢复提示误导有新历史）", () => {
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: "t-gone" }, undefined, TOOLS)?.kind, "tool-missing");
	// 老数据没有 acpToolId（迁移兜底）也按工具缺失处理。
	assert.equal(resolveAcpRestoreHint({ backend: "acp", acpSessionId: "ses-x", acpToolId: null }, undefined, TOOLS)?.kind, "tool-missing");
});
