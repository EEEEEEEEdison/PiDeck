import { useAtomValue, useSetAtom } from "jotai";
import { FileSearch } from "lucide-react";
import type { SessionRecord } from "../../../../shared/types";
import { pendingMessageJumpAtom, sessionRecordsAtom } from "../../atoms";
import { useSessionContentSearch } from "../../hooks/useSessionContentSearch";
import { t } from "../../i18n";
import { TitleScrollText } from "./TitleScrollText";

/**
 * 侧栏跨会话正文搜索结果：搜索词非空时展示正文命中的会话（标题 + 命中数 + 首条片段）。
 * 结果按 filePath（= SessionRecord.id，会话文件即稳定身份）映射回 catalog 记录；
 * 点击打开会话并挂 pendingMessageJump 定位到首个命中消息。
 * 无 sidecar/降级/无结果时隐藏，不影响既有标题过滤。
 */
type ContentSearchHit = { record: SessionRecord; matchCount: number; firstMessageId: string; snippet: string };

export function SessionContentSearchResults(props: { query: string; onOpen: (projectId: string, sessionId: string) => void }) {
	const results = useSessionContentSearch(props.query);
	const records = useAtomValue(sessionRecordsAtom);
	const setPendingMessageJump = useSetAtom(pendingMessageJumpAtom);
	const matched = (results?.sessions ?? [])
		.map((hit): ContentSearchHit | undefined => {
			const record: SessionRecord | undefined = records[hit.filePath];
			const first = hit.matches[0];
			return record && first ? { record, matchCount: hit.matches.length, firstMessageId: first.messageId, snippet: first.snippet } : undefined;
		})
		.filter((item): item is ContentSearchHit => Boolean(item));
	if (matched.length === 0) return null;

	const openHit = (record: SessionRecord, messageId: string) => {
		setPendingMessageJump({ sessionId: record.id, messageId });
		props.onOpen(record.projectId, record.id);
	};

	return (
		<div className="session-content-search-results flex shrink-0 flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 p-1.5">
			<div className="flex items-center gap-1.5 px-1 text-micro text-text-tertiary">
				<FileSearch size={10} aria-hidden="true" />
				<span>{t("sidebar.sessionContentResults", { count: results?.totalHitSessions ?? matched.length })}</span>
				{results?.truncated ? <span className="truncate">{t("sidebar.sessionContentTruncated")}</span> : null}
			</div>
			{matched.map(({ record, matchCount, firstMessageId, snippet }) => (
				<button key={record.id} type="button" className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50" onClick={() => openHit(record, firstMessageId)}>
					<TitleScrollText text={record.title} className="w-full flex-none text-control font-medium text-foreground" />
					<span className="flex min-w-0 items-center gap-1.5 text-caption text-text-tertiary">
						<span className="shrink-0">{t("sidebar.sessionContentMatchCount", { count: matchCount })}</span>
						<span className="truncate text-text-secondary">{snippet}</span>
					</span>
				</button>
			))}
		</div>
	);
}
