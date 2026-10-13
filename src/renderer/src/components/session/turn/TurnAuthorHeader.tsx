import type { AgentBackend } from "../../../../../shared/types";
import { useAtomValue } from "jotai";
import { t } from "../../../i18n";
import { acpToolsAtom } from "../../../atoms";
import { Avatar, AvatarFallback } from "../../ui-shadcn/avatar";
import { AcpToolLogo, DshLogo, PiLogo } from "../SessionSourceBadge";
import { formatTime } from "../TimelineFormat";

/**
 * AI 回复行头：圆形品牌头像 + 时间。
 *
 * 业务规则：
 * - 时间线必须同时展示 Pi 与 DSH logo。Pi 虽是默认后端，但回复气泡需要明确“是谁在说话”，
 *   不能沿用侧栏 `SessionBackendMark`「Pi 不署名」的降噪策略。
 * - 可见层只留 logo，不再跟文字（头像已能区分后端）；名称走 aria-label / title，
 *   给读屏和悬停辨认，避免纯装饰图标无法区分。
 * - ACP 会话按记录绑定的工具显示各家品牌 logo（OpenCode / Codex / Claude …），
 *   而不是统一的终端图标——否则同一会话里分不清是哪个 CLI 在回答；工具已删除时
 *   回退通用终端图标 + 通用名「ACP」。
 * - 头像走品牌内联 SVG（Fallback），不拉远程图，保证离线会话也能辨认。
 * - 时间后跟本轮实际使用的模型（provider + modelId）：同一会话内用户会频繁换模型，
 *   只在输入框显示当前模型不足以回看历史轮；文案是数据不是词典，不占位时不留空格。
 */
export function TurnAuthorHeader(props: { backend?: AgentBackend; acpToolId?: string; endedAt: number; model?: { provider: string; modelId: string } }) {
	const backend: AgentBackend = props.backend ?? "pi";
	const isDsh = backend === "dsh";
	const isAcp = backend === "acp";
	const acpTool = useAtomValue(acpToolsAtom).find((tool) => tool.id === props.acpToolId);
	const name = isDsh ? t("sessionBackend.dsh") : isAcp ? (acpTool?.name ?? t("sessionBackend.acp")) : t("sessionBackend.pi");

	return (
		<div className="mb-1 flex items-center gap-2" data-turn-author={backend} aria-label={name}>
			<Avatar title={name} className="bg-muted text-foreground">
				{/* 无 AvatarImage：品牌 logo 是矢量资源，失败态就是正常态。 */}
				<AvatarFallback delayMs={0} className="bg-transparent text-current">
					{isDsh ? <DshLogo className="size-4" /> : isAcp ? <AcpToolLogo tool={acpTool} className="size-4" /> : <PiLogo className="size-4" />}
				</AvatarFallback>
			</Avatar>
			{/* 时间/耗时数字统一走界面字体（与输入框下方统计条一致），不跟代码/路径一起用等宽字体；
			    数字本身等宽，流式跳动也不会左右抖（Segoe UI 等基数字体实测通过）。 */}
			<time className="shrink-0 text-body leading-none text-muted-foreground tabular-nums">{formatTime(props.endedAt)}</time>
			{props.model && (
				// 模型名长短不一（如 Kwai-Kolors/Kolors），限宽截断 + title 给全量 provider/model，
				// 不让长名字把行头撑开或换行。
				<span className="min-w-0 truncate text-body leading-none text-muted-foreground/80" title={`${props.model.provider}/${props.model.modelId}`} data-turn-model={props.model.modelId}>
					{props.model.modelId}
				</span>
			)}
		</div>
	);
}
