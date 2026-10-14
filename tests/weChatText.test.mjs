import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 微信出站文本适配测试（weChatText）。
 *
 * 这一层的作用是「把 Agent 的 Markdown 变成聊天窗里读得懂的字」，因此测试重点
 * 不是渲染保真度，而是两条不可回退的性质：
 * 1. 内容不许被改坏——路径、命令、代码块里的字符必须原样保留；
 * 2. 分段不许丢内容——切分后的片段拼回来仍然是原文（去掉换行边界差异）。
 */

const load = createTsSandbox({});
const { stripActionMarkers, stripMarkdown, prepareOutgoingText, splitForWeChat, pickLatestAssistantText, WECHAT_TEXT_CHUNK_MAX } = load("src/main/wechat/weChatText.ts");

test("host action markers are removed because WeChat has no attachments", () => {
	const out = stripActionMarkers("[SEND_FILE:report.pdf]\n这是结论\n[CREATE_DOC:notes.md]");
	assert.equal(out, "这是结论");
});

test("an inline action marker does not split the surrounding sentence", () => {
	const out = stripActionMarkers("结果如下 [SEND_FILE:a.txt] 请查收");
	assert.equal(out, "结果如下  请查收");
});

test("headings, emphasis and inline code lose their markers but keep the text", () => {
	const out = stripMarkdown("### 标题\n\n**重点** 与 `npm run dev` 命令");
	assert.ok(!out.includes("#"), "heading markers must go");
	assert.ok(!out.includes("**"), "bold markers must go");
	assert.ok(out.includes("标题"));
	assert.ok(out.includes("重点"));
	assert.ok(out.includes("npm run dev"), "inline code content is what the user needs to read");
});

test("a fenced code block keeps its content and loses only the fence lines", () => {
	const out = stripMarkdown("```bash\ncd /tmp/x && ls\n```");
	assert.ok(!out.includes("```"));
	assert.ok(out.includes("cd /tmp/x && ls"), "commands must survive untouched");
});

test("links degrade to text plus a copyable bare url", () => {
	assert.equal(stripMarkdown("[文档](https://example.com/a)"), "文档 (https://example.com/a)");
	assert.equal(stripMarkdown("[](https://example.com/a)"), "https://example.com/a");
	assert.equal(stripMarkdown("![截图](https://example.com/b.png)"), "截图 (https://example.com/b.png)");
});

test("tables lose their pipe scaffolding and the alignment row", () => {
	const out = stripMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
	assert.ok(!out.includes("|"));
	assert.ok(out.includes("a  b"));
	assert.ok(out.includes("1  2"));
	assert.ok(!out.includes("---"), "the alignment row must not leak into the message");
});

test("an indented path is never rewritten by the markdown pass", () => {
	const out = stripMarkdown("  D:/project/github/pi-desktop/src/main/wechat/WeChatBridge.ts");
	assert.equal(out, "D:/project/github/pi-desktop/src/main/wechat/WeChatBridge.ts");
});

test("prepareOutgoingText composes marker stripping with markdown degradation", () => {
	const out = prepareOutgoingText("[SEND_FILE:x.txt]\n## 结果\n\n- **完成**\n");
	assert.equal(out, "结果\n\n- 完成");
});

test("splitting at line boundaries never loses content", () => {
	const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
	const chunks = splitForWeChat(text, 100);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) assert.ok(chunk.length <= 100, "each chunk must respect the limit");
	assert.equal(chunks.join("\n"), text, "rejoining must reproduce the original");
});

test("an overlong single line is hard-split instead of being dropped", () => {
	const long = "x".repeat(250);
	const chunks = splitForWeChat(`head\n${long}\ntail`, 100);
	assert.equal(chunks.join("\n").replace(/\n/g, ""), "head".concat(long, "tail"));
	for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test("a path longer than the limit is still delivered in full", () => {
	const path = `D:/${"deep/".repeat(400)}file.ts`;
	const chunks = splitForWeChat(path, 100);
	assert.equal(chunks.join(""), path, "an overlong line may be cut but must not lose characters");
});

test("empty and whitespace inputs produce no messages instead of blank bubbles", () => {
	// 注意：沙箱是独立 realm，数组原型不同，deepStrictEqual 会假失败，只能比序列化结果。
	assert.equal(JSON.stringify(splitForWeChat("")), "[]");
	assert.equal(JSON.stringify(splitForWeChat("", 100)), "[]");
});

test("text within the limit is returned as a single message", () => {
	assert.equal(JSON.stringify(splitForWeChat("hello", WECHAT_TEXT_CHUNK_MAX)), JSON.stringify(["hello"]));
});

test("the reply picks the last non-empty assistant message", () => {
	const messages = [
		{ role: "user", text: "hi" },
		{ role: "assistant", text: "first" },
		{ role: "user", text: "again" },
		{ role: "assistant", text: "   " },
		{ role: "assistant", text: "second" },
	];
	assert.equal(pickLatestAssistantText(messages), "second");
});

test("no assistant message means no reply text rather than an empty bubble", () => {
	assert.equal(pickLatestAssistantText([{ role: "user", text: "hi" }]), "");
	assert.equal(pickLatestAssistantText([]), "");
	assert.equal(pickLatestAssistantText([{ role: "assistant" }]), "");
});
