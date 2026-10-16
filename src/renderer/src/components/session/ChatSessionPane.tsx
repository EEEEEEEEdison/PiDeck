import React, { useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { pendingMessageJumpAtom, sessionRecordByIdAtomFamily } from "../../atoms";
import { useSessionTimelineController } from "../../hooks/useSessionTimelineController";
import { SessionRuntimeInjector } from "./SessionRuntimeInjector";
import { useSessionPaneServices } from "./SessionPaneServices";
import { t } from "../../i18n";

export type ChatSessionPaneProps = {
	sessionId: string;
	focused: boolean;
	onFocusPane: () => void;
	/** 分屏双栏时为 true（边框高亮）；单栏 Tab 外置时为 false */
	splitPane?: boolean;
};

/**
 * 单个会话聊天栏：自持 timeline + runtime 注入。
 * 共享服务来自 SessionPaneServices；Tab 栏由 App 外置统一挂载。
 */
export function ChatSessionPane(props: ChatSessionPaneProps) {
	const { sessionId, focused, onFocusPane, splitPane = false } = props;
	const services = useSessionPaneServices();
	const setPendingMessageJump = useSetAtom(pendingMessageJumpAtom);
	const pendingJump = useAtomValue(pendingMessageJumpAtom);

	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const sessionTitle = record?.title?.trim() || t("app.chatProject");

	const sessionTimeline = useSessionTimelineController({ sessionId });

	const localHeaderRef = useRef<HTMLDivElement | null>(null);
	const localComposerRef = useRef<HTMLElement | null>(null);
	const localQueuedTrackRef = useRef<HTMLElement | null>(null);

	const layoutRefs = services.layoutRefs;
	const chatHeaderRef = focused ? layoutRefs.chatHeaderRef : localHeaderRef;
	const composerRef = focused ? layoutRefs.composerRef : localComposerRef;

	const activeQueuedPrompts = services.queuedPromptsBySession[sessionId] ?? [];

	useEffect(() => {
		if (!focused) return;
		services.jumpToMessageRef.current = sessionTimeline.jumpToMessage;
		return () => {
			if (services.jumpToMessageRef.current === sessionTimeline.jumpToMessage) {
				services.jumpToMessageRef.current = null;
			}
		};
	}, [focused, services.jumpToMessageRef, sessionTimeline.jumpToMessage]);

	// 跨会话正文搜索的落地跳转：目标 pane 聚焦且 jump 挂好后消费一次。
	// 消息尚未加载（messages 空且未确认空会话）时先不消费：加载完成后
	// jumpToMessage 引用随 combinedMessages 更新，本 effect 重触发重试；
	// jumpToMessage 内部另有补页/扩窗挂起策略处理「目标在未加载历史页」的情况。
	useEffect(() => {
		if (!focused || !pendingJump || pendingJump.sessionId !== sessionId) return;
		if (sessionTimeline.messages.length === 0 && !sessionTimeline.knownEmpty) return;
		sessionTimeline.jumpToMessage(pendingJump.messageId);
		setPendingMessageJump(null);
	}, [focused, pendingJump, sessionId, sessionTimeline.jumpToMessage, sessionTimeline.messages, sessionTimeline.knownEmpty, setPendingMessageJump]);

	const layout = useMemo(
		() => ({
			chatHeaderRef,
			composerRef,
			composerOffsetHeight: focused ? layoutRefs.composerOffsetHeight : 0,
			terminalRowHeight: layoutRefs.terminalRowHeight,
		}),
		[chatHeaderRef, composerRef, focused, layoutRefs],
	);

	return (
		<SessionRuntimeInjector
			currentSessionId={sessionId}
			sessionTitle={sessionTitle}
			sessionTimeline={sessionTimeline}
			splitPane={splitPane}
			focused={focused}
			onFocusPane={onFocusPane}
			chatHeaderRef={layout.chatHeaderRef}
			composerRef={layout.composerRef}
			composerOffsetHeight={layout.composerOffsetHeight}
			terminalRowHeight={layout.terminalRowHeight}
			activeQueuedPrompts={activeQueuedPrompts}
			queuedTrackRef={localQueuedTrackRef}
		/>
	);
}
