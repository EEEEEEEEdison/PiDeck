import { useLayoutEffect, type RefObject } from "react";
import type { FileTreeNode } from "../../../../shared/types";

/** 只给真正吸顶的最后一行加底部阴影；普通目录行不出现卡片分隔。 */
export function useFileTreeStickyAppearance(panelRef: RefObject<HTMLDivElement | null>, files: FileTreeNode[], expandedDirs: Set<string>, enabled: boolean) {
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel || !enabled) return;
		const rows = Array.from(panel.querySelectorAll<HTMLButtonElement>("[data-file-sticky-level]"));
		let frame: number | null = null;

		const measure = () => {
			frame = null;
			const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
			// 先读完几何再写标记，避免滚动过程中读写交错。父容器保留目录的自然位置，
			// 而 sticky 行被浏览器移到顶部；只有两者错开且行到达吸顶槽位才算真正吸顶。
			const pinned = rows.map((row) => {
				const top = row.getBoundingClientRect().top;
				const naturalTop = row.parentElement?.getBoundingClientRect().top ?? top;
				const stickyTop = panelTop + Number.parseFloat(getComputedStyle(row).top);
				return top > naturalTop + 1 && Math.abs(top - stickyTop) < 1;
			});
			const lastPinnedIndex = pinned.lastIndexOf(true);
			for (const [index, row] of rows.entries()) {
				row.dataset.fileStuck = String(pinned[index]);
				row.dataset.fileStickyLast = String(index === lastPinnedIndex);
			}
		};
		const schedule = () => {
			if (frame === null) frame = requestAnimationFrame(measure);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(panel);
		for (const row of rows) {
			if (row.parentElement) observer.observe(row.parentElement);
		}
		panel.addEventListener("scroll", schedule, { passive: true });
		measure();

		return () => {
			panel.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
			for (const row of rows) {
				delete row.dataset.fileStuck;
				delete row.dataset.fileStickyLast;
			}
		};
	}, [panelRef, files, expandedDirs, enabled]);
}
