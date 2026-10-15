import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const fsPromises = nodeRequire("node:fs/promises");
const { buildSessionOriginKey, toAbsoluteSessionPath } = loadTsCommonJs("src/shared/sessionIdentity.ts");
const { getProjectAgentSessionDisplay } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
const SESSION_PATH = "/Users/Fixture/Project/.pi/sessions/2026-10-07T12-34-56-000Z_abcdef01.jsonl";

/** 完整旧目录记录：使用真实身份构造器，仅旧键模拟升级前的 POSIX 小写规则。 */
function entry(overrides = {}) {
	const record = {
		id: "original-session",
		projectId: "project-1",
		title: "A",
		titleLocked: true,
		titleOrigin: "manual",
		source: "pi",
		environment: "native",
		filePath: SESSION_PATH,
		status: "active",
		createdAt: 10,
		updatedAt: 100,
		...overrides,
	};
	return { originKey: buildSessionOriginKey(record), ...record };
}

/** 所有写入均限制在本测试的临时目录；POSIX 路径夹具只参与身份比较，不接触真实用户文件。 */
async function withCatalog(entries, run, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-identity-repair-"));
	const catalogPath = join(dir, "session-catalog.json");
	try {
		await writeFile(catalogPath, JSON.stringify({ version: 1, sessions: entries }), "utf8");
		const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
			stubs: {
				"node:fs/promises": options.fsPromises ?? fsPromises,
				"node:fs": { existsSync: () => true },
				"../logging/sharedLogger": { getAppLogger: () => null },
			},
		});
		const resolveFilePath = options.withoutResolver ? undefined : (options.resolveFilePath ?? ((_projectId, path, environment) => toAbsoluteSessionPath(path, "/Users/Fixture/Project", environment)));
		const createCatalog = () => new SessionCatalog(catalogPath, {}, resolveFilePath);
		await run({ catalog: createCatalog(), createCatalog, catalogPath });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 生产 listPathSummary 的轻量形态：扫描只带文件时间，不提供覆盖人工标题的名称。 */
function summary(updatedAt = 100) {
	return { id: SESSION_PATH, filePath: SESSION_PATH, source: "pi", preview: "", messageCount: 0, updatedAt };
}

/** 侧栏和搜索共用目录记录；侧栏额外按路径归并，必须与按 ID 取标题的 Tab 一致。 */
function sidebarTitle(records) {
	const display = getProjectAgentSessionDisplay({
		agents: [],
		sessions: records.map((record) => ({ id: record.id, filePath: record.filePath, source: record.source, name: record.title, preview: record.preview, messageCount: record.messageCount, updatedAt: record.updatedAt })),
	});
	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	return display.children[0].session.name;
}

test("#354 repairs an unchanged absolute POSIX path's old key before scanning without replacing its stable ID", async () => {
	const old = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	await withCatalog([old], async ({ catalog, createCatalog, catalogPath }) => {
		await catalog.load();
		assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
		const records = await catalog.mergeScanned("project-1", [summary()]);
		assert.equal(records.length, 1);
		assert.equal(records[0].id, old.id);
		assert.equal(records[0].title, old.title);
		assert.equal(JSON.parse(await readFile(catalogPath, "utf8")).sessions[0].originKey, buildSessionOriginKey(old));
		assert.equal(JSON.parse(await readFile(`${catalogPath}.bak`, "utf8")).sessions[0].originKey, old.originKey, "atomic catalog backup retains the pre-repair index");
		const repairedSnapshot = await readFile(catalogPath, "utf8");
		await createCatalog().load();
		assert.equal(await readFile(catalogPath, "utf8"), repairedSnapshot, "the repair must be idempotent across restart");
	});
});

test("#354 repairs a missing absolute-path identity key even without a project path resolver", async () => {
	const old = entry({ originKey: undefined });
	await withCatalog(
		[old],
		async ({ catalog }) => {
			await catalog.load();
			assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
			assert.equal((await catalog.mergeScanned("project-1", [summary()])).length, 1);
		},
		{ withoutResolver: true },
	);
});

test("#354 folds already persisted duplicates into the original ID while preserving the latest manual title and metadata", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, manualProjectAssignment: true, model: { provider: "provider", modelId: "model" } });
	const duplicate = entry({ id: "scanned-duplicate", title: "A2", createdAt: 20, updatedAt: 200, thinkingLevel: "high", piSessionId: "pi-session", forked: true });
	const predecessor = entry({ id: "predecessor", filePath: "/Users/Fixture/Project/.pi/sessions/previous.jsonl", supersededBy: duplicate.id });
	await withCatalog([duplicate, original, predecessor], async ({ catalog, createCatalog, catalogPath }) => {
		await catalog.load();
		const repaired = catalog.get(original.id);
		assert.ok(repaired);
		assert.equal(catalog.get(duplicate.id), undefined, "the scanner-generated extra identity is removed, not the original session");
		assert.equal(repaired.title, "A2");
		assert.equal(repaired.titleOrigin, "manual");
		assert.equal(repaired.createdAt, original.createdAt);
		assert.equal(repaired.updatedAt, duplicate.updatedAt);
		assert.equal(repaired.model.modelId, "model");
		assert.equal(repaired.thinkingLevel, "high");
		assert.equal(repaired.piSessionId, "pi-session");
		assert.equal(repaired.forked, true);
		assert.equal(repaired.manualProjectAssignment, true);
		assert.equal(catalog.get(predecessor.id).supersededBy, original.id, "catalog replacement references must follow the retained stable ID");
		assert.equal(catalog.listEntries().length, 2);
		const snapshot = await readFile(catalogPath, "utf8");
		const restarted = createCatalog();
		await restarted.load();
		assert.equal(restarted.get(original.id).title, "A2");
		assert.equal(await readFile(catalogPath, "utf8"), snapshot);
	});
});

test("#354 the old-key session keeps its ID even when a scanner duplicate carries an earlier file timestamp", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, createdAt: 30 });
	const duplicate = entry({ id: "scanned-duplicate", createdAt: 20, updatedAt: 200, title: "A2" });
	await withCatalog([duplicate, original], async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.listEntries()[0].id, original.id, "file timestamps are not evidence that a scanner-created ID predates the legacy identity");
		assert.equal(catalog.get(original.id).title, "A2");
	});
});

test("#354 unresolved entries with colliding legacy keys are preserved rather than guessed to be duplicates", async () => {
	const upper = entry({ id: "upper", originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const lower = entry({ id: "lower", filePath: SESSION_PATH.toLowerCase() });
	await withCatalog(
		[upper, lower],
		async ({ catalog, catalogPath }) => {
			const before = await readFile(catalogPath, "utf8");
			await catalog.load();
			assert.equal(catalog.listEntries().length, 2);
			assert.equal(await readFile(catalogPath, "utf8"), before);
		},
		{ resolveFilePath: () => undefined },
	);
});

test("#354 a newer scanned or automatic name cannot displace a duplicate's manual title during repair", async () => {
	const original = entry({ title: "User title", originKey: `pi:native:${SESSION_PATH.toLowerCase()}`, updatedAt: 100 });
	const automatic = entry({ id: "duplicate-auto", title: "Automatic title", titleOrigin: "auto", createdAt: 20, updatedAt: 300 });
	await withCatalog([original, automatic], async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.get(original.id).title, "User title");
		assert.equal(catalog.get(original.id).titleOrigin, "manual");
	});
});

test("#354 repeated renames and unchanged confirmations keep Tab, sidebar and search on one repaired record", async () => {
	const original = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const duplicate = entry({ id: "scanned-duplicate", createdAt: 20, updatedAt: 200 });
	await withCatalog([original, duplicate], async ({ catalog }) => {
		await catalog.load();
		for (const title of ["A1", "A2", "A2", "A2"]) {
			await catalog.claimTitleOwnership(original.id);
			const renamed = await catalog.update(original.id, { title });
			const records = await catalog.mergeScanned("project-1", [summary(renamed.updatedAt)]);
			assert.equal(records.length, 1, "search must not contain a second title for the same file");
			assert.equal(records[0].id, original.id);
			assert.equal(sidebarTitle(records), title);
			assert.equal(catalog.getRecord(original.id).title, title);
			await catalog.attachRuntime({ sessionId: original.id, filePath: SESSION_PATH, piSessionId: "pi-session" });
			assert.equal(catalog.listEntries().length, 1);
		}
	});
});

test("#354 repair does not collapse distinct POSIX case, imported source identities or WSL distributions", async () => {
	const upper = entry({ id: "upper", originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	const lower = entry({ id: "lower", filePath: SESSION_PATH.toLowerCase() });
	const codexA = entry({ id: "codex-a", source: "codex", importedSourceId: "source-a" });
	const codexB = entry({ id: "codex-b", source: "codex", importedSourceId: "source-b" });
	const wslA = entry({ id: "wsl-a", environment: "wsl", wslDistro: "DistroA", wslUser: "user" });
	const wslB = entry({ id: "wsl-b", environment: "wsl", wslDistro: "DistroB", wslUser: "user" });
	const entries = [upper, lower, codexA, codexB, wslA, wslB];
	await withCatalog(entries, async ({ catalog }) => {
		await catalog.load();
		assert.equal(catalog.listEntries().length, entries.length);
		for (const expected of entries) {
			assert.equal(catalog.get(expected.id).originKey, buildSessionOriginKey(expected));
		}
	});
});

test("#354 an unwritable repair snapshot leaves original disk data intact and still repairs the in-memory catalog", async () => {
	const old = entry({ originKey: `pi:native:${SESSION_PATH.toLowerCase()}` });
	await withCatalog(
		[old],
		async ({ catalog, catalogPath }) => {
			const before = await readFile(catalogPath, "utf8");
			await catalog.load();
			assert.equal(catalog.get(old.id).originKey, buildSessionOriginKey(old));
			assert.equal(await readFile(catalogPath, "utf8"), before);
		},
		{
			fsPromises: {
				...fsPromises,
				open: async () => {
					throw Object.assign(new Error("read-only test filesystem"), { code: "EROFS" });
				},
			},
		},
	);
});
