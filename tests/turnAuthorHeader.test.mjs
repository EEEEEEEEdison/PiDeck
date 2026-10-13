import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const header = readFileSync("src/renderer/src/components/session/turn/TurnAuthorHeader.tsx", "utf8");
const backendMark = readFileSync("src/renderer/src/components/session/SessionSourceBadge.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("TurnRow always mounts a Pi/DSH author header, not DSH-only text", () => {
	// 行头签名：头像 + 时间 + 本轮实际使用的模型（model 允许缺省，旧数据/ACP 会话不显示）。
	// 正则必须空白容忍，否则改一次格式化整组断言就红。
	assert.match(turnRow, /<TurnAuthorHeader[\s\S]*?backend=\{props\.backend\}[\s\S]*?acpToolId=\{props\.acpToolId\}[\s\S]*?endedAt=\{run\.endedAt\}[\s\S]*?model=\{turnModel\}[\s\S]*?\/>/);
	// 旧策略：Pi 默认不署名、只给 DSH 短标签。时间线行头已改回两边都用 logo。
	assert.doesNotMatch(turnRow, /props\.backend === "dsh" &&/);
	assert.doesNotMatch(turnRow, /sessionBackend\.dsh/);
});

test("TurnAuthorHeader uses shadcn Avatar logos without a visible name", () => {
	assert.match(header, /from "\.\.\/\.\.\/ui-shadcn\/avatar"/);
	assert.match(header, /<Avatar title=\{name\}/);
	assert.match(header, /<AvatarFallback/);
	assert.match(header, /<PiLogo/);
	assert.match(header, /<DshLogo/);
	assert.match(header, /data-turn-author=\{backend\}/);
	// 缺省按 pi 处理，兼容旧调用方不传 backend
	assert.match(header, /props\.backend \?\? "pi"/);
	// 名称只给读屏/悬停，不再跟在 logo 旁边当可见署名
	assert.match(header, /aria-label=\{name\}/);
	assert.match(header, /sessionBackend\.pi/);
	assert.match(header, /sessionBackend\.dsh/);
	// ACP 回复头不能冒充 pi：按会话绑定的工具显示各家品牌 logo（工具已删则回退通用终端图标），
	// 名称同理回退通用名「ACP」（用户反馈：只给通用终端图标分不清是哪个 CLI 在回答）
	assert.match(header, /isAcp \? <AcpToolLogo tool=\{acpTool\}/);
	assert.match(header, /acpTool\?\.name \?\? t\("sessionBackend\.acp"\)/);
	assert.match(header, /acpToolId\?: string/);
	// 工具 id 必须从会话记录一路传到行头（中间断一环就退化成通用图标）
	assert.match(timeline, /acpToolId=\{session\?\.acpToolId\}/);
	assert.match(header, /sessionBackend\.acp/);
	assert.doesNotMatch(header, /<span[^>]*>\{\s*name\s*\}<\/span>/);
});

test("TurnAuthorHeader shows the turn model after the time (data-only, no dictionary copy)", () => {
	// 同一会话内用户会频繁换模型，行头逐轮显示本条回答用的模型；provider/model 是数据，
	// 不进词典；缺省时不占位。
	assert.match(header, /model\?: \{ provider: string; modelId: string \}/);
	assert.match(header, /props\.model && \(/);
	assert.match(header, /data-turn-model=\{props\.model\.modelId\}/);
	assert.match(header, /\{props\.model\.modelId\}/);
	// 模型名长短不一，必须限宽截断 + title 给全量 provider/model
	assert.match(header, /min-w-0 truncate[^"]*"/);
	assert.match(header, /title=\{`\$\{props\.model\.provider\}\/\$\{props\.model\.modelId\}`\}/);
});

test("sidebar SessionBackendMark still hides Pi to avoid list noise", () => {
	// 侧栏/Tab 降噪策略保持不变：只有非默认后端（dsh/imagegen/acp）才打标（acp 用终端图标+Agent CLI）。
	assert.match(backendMark, /if \(props\.backend === "dsh" \|\| props\.backend === "imagegen" \|\| props\.backend === "acp"\)/);
	assert.match(backendMark, /<SessionBackendBadge backend=\{props\.backend\}/);
	assert.match(backendMark, /return null;/);
});
