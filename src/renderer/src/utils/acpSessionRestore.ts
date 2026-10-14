/**
 * 未激活 ACP 会话「历史恢复提示」的判定（纯函数，组件薄壳）。
 *
 * 背景：ACP 会话没有本地历史文件——历史存在 agent CLI 侧，只有激活
 * （spawn + session/load 重放）后才能投影进时间线。用户从侧栏点开未激活
 * ACP 会话时，根本看到全空时间线 + 新会话起始页，容易被当成会话丢失 bug。
 * 据此渲染一条恢复提示；激活后（runtime 绑定）或新草稿（无 acpSessionId）不显示。
 */
import type { AcpToolConfig } from "../../../shared/types/acp";

export type AcpRestoreHint = { kind: "restore"; toolName: string } | { kind: "tool-missing" };

export function resolveAcpRestoreHint(record: { backend?: string; acpSessionId?: string | null; acpToolId?: string | null } | undefined, runtimeAgentId: string | undefined, tools: readonly AcpToolConfig[]): AcpRestoreHint | undefined {
	if (!record || record.backend !== "acp") return undefined;
	if (runtimeAgentId) return undefined;
	if (!record.acpSessionId) return undefined;
	const tool = record.acpToolId ? tools.find((candidate) => candidate.id === record.acpToolId) : undefined;
	if (!tool) return { kind: "tool-missing" };
	return { kind: "restore", toolName: tool.name };
}
