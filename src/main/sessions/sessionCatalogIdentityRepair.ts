import type { SessionCatalogEntry, SessionFilePathResolver } from "./SessionCatalog";

/** 非文件会话由各自后端持久化，不参与 pi JSONL 的身份修复或归并。 */
function isFileSession(entry: SessionCatalogEntry): boolean {
	return Boolean(entry.filePath) && (!entry.backend || entry.backend === "pi");
}

/** 明确人工命名优先，其次保守保留存量所有权；自动/首句标题不能覆盖用户选择。 */
function titlePriority(entry: SessionCatalogEntry): number {
	switch (entry.titleOrigin) {
		case "manual":
			return 4;
		case "legacy":
			return 3;
		case "auto":
			return 2;
		case "fallback":
			return 1;
		default:
			return 0;
	}
}

/** 旧键条目优先保留原始 ID，其余按最早 createdAt 归并；标题与缺失元数据独立选取。 */
function mergeDuplicateEntries(left: SessionCatalogEntry, right: SessionCatalogEntry, legacyIdentityIds: ReadonlySet<string>): SessionCatalogEntry {
	const preferRight = legacyIdentityIds.has(left.id) === legacyIdentityIds.has(right.id) ? right.createdAt < left.createdAt : legacyIdentityIds.has(right.id);
	const original = preferRight ? right : left;
	const duplicate = original === left ? right : left;
	const titleDifference = titlePriority(duplicate) - titlePriority(original);
	const titleOwner = titleDifference > 0 || (titleDifference === 0 && duplicate.updatedAt > original.updatedAt) ? duplicate : original;
	const assignment = duplicate.manualProjectAssignment && !original.manualProjectAssignment ? duplicate : original;
	return {
		...duplicate,
		...original,
		projectId: assignment.projectId,
		manualProjectAssignment: original.manualProjectAssignment || duplicate.manualProjectAssignment,
		title: titleOwner.title,
		titleOrigin: titleOwner.titleOrigin,
		titleLocked: titleOwner.titleLocked,
		updatedAt: Math.max(left.updatedAt, right.updatedAt),
		model: original.model ?? duplicate.model,
		thinkingLevel: original.thinkingLevel ?? duplicate.thinkingLevel,
		permissionPreset: original.permissionPreset ?? duplicate.permissionPreset,
		proxy: original.proxy ?? duplicate.proxy,
		piSessionId: original.piSessionId ?? duplicate.piSessionId,
		channel: original.channel ?? duplicate.channel,
		parentSessionPath: original.parentSessionPath ?? duplicate.parentSessionPath,
		forked: original.forked || duplicate.forked,
		supersededBy: original.supersededBy ?? duplicate.supersededBy,
	};
}

/**
 * #354：路径不变也必须重算派生身份键，修复 native POSIX 从全小写切到保留大小写的旧索引。
 * 只在启动、运行时尚未恢复前归并真实同源记录；保留原始 ID，不触碰会话 JSONL。
 * 返回 undefined 表示无需落盘；调用方复用 catalog 的备份、原子写与失败降级。
 */
export function repairSessionCatalogIdentities(entries: readonly SessionCatalogEntry[], resolveFilePath: SessionFilePathResolver | undefined, originKeyForEntry: (entry: SessionCatalogEntry) => string | undefined): SessionCatalogEntry[] | undefined {
	let changed = false;
	const verifiedIdentityIds = new Set<string>();
	const legacyIdentityIds = new Set<string>();
	const normalized = entries.map((entry) => {
		if (!isFileSession(entry)) return entry;
		const filePath = entry.filePath;
		if (!filePath) return entry;
		const resolved = resolveFilePath ? resolveFilePath(entry.projectId, filePath, entry.environment) : filePath;
		if (!resolved) return entry;
		const repaired = resolved === filePath ? entry : { ...entry, filePath: resolved };
		const originKey = originKeyForEntry(repaired);
		if (originKey) verifiedIdentityIds.add(entry.id);
		// 扫描条目的 createdAt 来自文件 mtime，未必晚于原记录；旧 native 小写键
		// 才是升级前身份的证据，不能只按文件时间决定保留哪个 ID。
		if (entry.environment === "native" && entry.originKey && entry.originKey !== originKey && entry.originKey === originKeyForEntry({ ...repaired, filePath: resolved.toLowerCase() })) legacyIdentityIds.add(entry.id);
		if (repaired === entry && originKey === entry.originKey) return entry;
		changed = true;
		return { ...repaired, originKey };
	});

	const next: SessionCatalogEntry[] = [];
	const indexByOrigin = new Map<string, number>();
	for (const entry of normalized) {
		// resolver 未能确认路径时，不得拿仍可能碰撞的旧键做破坏性归并。
		const originKey = verifiedIdentityIds.has(entry.id) ? entry.originKey : undefined;
		const index = originKey ? indexByOrigin.get(originKey) : undefined;
		if (index === undefined) {
			if (originKey) indexByOrigin.set(originKey, next.length);
			next.push(entry);
		} else {
			next[index] = mergeDuplicateEntries(next[index], entry, legacyIdentityIds);
			changed = true;
		}
	}
	if (!changed) return undefined;

	// fork/重发的替换关系也按稳定 ID 存储，不能留下指向被归并记录的悬空引用。
	const retainedIds = new Map<string, string>();
	for (const entry of normalized) {
		const index = verifiedIdentityIds.has(entry.id) && entry.originKey ? indexByOrigin.get(entry.originKey) : undefined;
		if (index !== undefined) retainedIds.set(entry.id, next[index].id);
	}
	return next.map((entry) => {
		if (!entry.supersededBy) return entry;
		const target = retainedIds.get(entry.supersededBy) ?? entry.supersededBy;
		if (target === entry.id) return { ...entry, supersededBy: undefined };
		return target === entry.supersededBy ? entry : { ...entry, supersededBy: target };
	});
}
