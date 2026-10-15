/**
 * F3 · IPC 通道快照守卫（TEST-PLAN §F3，6 例，锚定数字见 TEST-PLAN §0）。
 *
 * src/shared/ipc.ts 的 ipcChannels 常量表是全部 IPC 通道的唯一来源；本测试把它的
 * 规模与形状锚定为快照（673 通道 / 84 前缀 / 排序摘要）。快照变更只允许显式发生
 * 且附领域正当理由——本轮（T4 契约层）任何快照红 = 违例。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CHANNEL_TOTAL = 673;
const PREFIX_COUNT = 84;
const CHANNEL_DIGEST = "a642034e5c7209ffaeb6d5bf9471b1a56959e4899a71a2c28d8b533ad5f39e09";

const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
const entries = Object.entries(ipcChannels);
const values = entries.map(([, value]) => value);

test("F3-1 通道常量总数 === 673", () => {
	assert.equal(entries.length, CHANNEL_TOTAL);
});

test("F3-2 通道值唯一数 === 673（无重复通道字符串）", () => {
	assert.equal(new Set(values).size, CHANNEL_TOTAL);
});

test("F3-3 全部通道值匹配 domain:action 形态", () => {
	for (const [key, value] of entries) {
		assert.match(value, /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/, `通道 ${key}=${value} 形态非法`);
	}
});

test("F3-4 key=value 排序串联 sha256 与快照摘要一致", () => {
	const serialized = entries
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
	const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
	assert.equal(digest, CHANNEL_DIGEST);
});

test("F3-5 锚点抽查：appGetChannel=update:get-channel、sessionsBridgeEvent=sessions:bridge-event、git=38、enhance=3", () => {
	assert.equal(ipcChannels.appGetChannel, "update:get-channel");
	assert.equal(ipcChannels.sessionsBridgeEvent, "sessions:bridge-event");
	const countByPrefix = (prefix) => values.filter((value) => value.startsWith(`${prefix}:`)).length;
	assert.equal(countByPrefix("git"), 38);
	assert.equal(countByPrefix("enhance"), 3);
});

test("F3-6 通道域前缀种类 === 84", () => {
	const prefixes = new Set(values.map((value) => value.split(":")[0]));
	assert.equal(prefixes.size, PREFIX_COUNT);
});
