import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pi 1.3.0 新增 `sessionShareDestination`（"auto" | "gist" | "radius"），控制 /share 上传目标。
 * 设置页必须给它常驻枚举下拉，而不是落进「其他设置项」的原始 JSON 兜底；
 * 值为字符串枚举，清空时删键回到 pi 默认 auto。
 */
test("SettingsTab 用三值下拉表达 pi 1.3.0 的 sessionShareDestination", () => {
	const tab = readFileSync("src/renderer/src/config/SettingsTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.ok(tab.includes('const SHARE_DESTINATION_OPTIONS = ["auto", "gist", "radius"].map'), "枚举选项必须与 pi 取值一致");
	assert.ok(tab.includes("sessionShareDestination: v }"), "选中值应原样写回表单");
	assert.ok(tab.includes("const { sessionShareDestination: _removed, ...rest } = data;"), "清空应删除键（回到 pi 默认 auto），而不是写空串");
	// 常驻区块占用：同一配置不能同时出现在「其他设置项」兜底列表
	assert.ok(tab.includes('key !== "sessionShareDestination"'), "该键必须从「其他设置项」过滤，避免两处入口");
	for (const key of ["config.label.sessionShareDestination", "config.general.shareDestinationHint", "config.general.shareDestinationPlaceholder"]) {
		assert.ok(zh.includes('"' + key + '"'), "zh-CN missing " + key);
		assert.ok(en.includes('"' + key + '"'), "en-US missing " + key);
	}
});
