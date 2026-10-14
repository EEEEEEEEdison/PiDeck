import { ArrowUpToLine } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui-shadcn/tooltip";

/** 吸顶标题唯一的附加操作：只显示图标，悬停/聚焦时说明用途。 */
export function ProcessEntryReturnToStart(props: { onClick: () => void }) {
	// 复用现有多语言的通用滚动文案，保持图标与 Tooltip 的可访问名称一致。
	const label = t("app.modelScrollToTop");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button type="button" variant="ghost" size="icon-xs" data-process-entry-return-to-start="" className="mr-1 text-text-tertiary hover:bg-bg-muted hover:text-text-secondary" aria-label={label} onClick={props.onClick}>
					<ArrowUpToLine size={12} aria-hidden="true" />
				</Button>
			</TooltipTrigger>
			{/* 显式 length：裸 text-chat-detail 会被 twMerge 当成颜色，吞掉 Tooltip 的 text-background。 */}
			<TooltipContent side="top" sideOffset={4} className="text-[length:var(--font-size-chat-detail)]">
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
