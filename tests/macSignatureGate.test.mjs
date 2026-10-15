// macOS 签名门禁的行为测试 + 接线守卫（issue #347 回归）。
//
// 被测对象是 scripts/verify-mac-signature.mjs：无 Apple 证书时 electron-builder 26.15+
// 不会自动回退 ad-hoc，签名被静默跳过，产出的 .app 在 Apple Silicon 上起不来而 CI 全绿。
// 门禁必须把这种产物判红，所以这里用临时 release 目录 + 注入的 codesign 执行器覆盖判定分支，
// 不依赖 macOS 与真实 codesign。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { findMacApps, verifyMacSignature } from "../scripts/verify-mac-signature.mjs";

// 0.9.0 官方 arm64 包上真实复现的 codesign 输出（缺资源封印时的报错原文）。
const UNSIGNED_OUTPUT = "code has no resources but signature indicates they must be present";

async function withTempRelease(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-mac-signature-"));
	try {
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function put(path, content = "content") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function createApp(releaseDir, outputDir, appName, { sealed = true } = {}) {
	const app = join(releaseDir, outputDir, appName);
	await put(join(app, "Contents", "MacOS", "PiDeck"), "binary");
	if (sealed) await put(join(app, "Contents", "_CodeSignature", "CodeResources"), "<plist/>");
	return app;
}

const okCodesign = () => ({ code: 0, output: "" });

test("签名完整（有资源封印且 codesign 通过）的包通过，并对每个 .app 跑 --verify --deep --strict", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		const calls = [];
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "darwin",
			runCodesign: async (args) => {
				calls.push(args);
				return okCodesign();
			},
		});
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.apps.length, 1);
		assert.equal(result.apps[0].sealed, true);
		assert.deepEqual(calls, [["--verify", "--deep", "--strict", "--verbose=2", app]]);
	});
});

test("0.9.0 那种「签名被跳过」的包被判红：缺 _CodeSignature/CodeResources 且 codesign 非 0", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac-arm64", "PiDeck.app", { sealed: false });
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "darwin",
			runCodesign: async () => ({ code: 1, output: UNSIGNED_OUTPUT }),
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /_CodeSignature[/\\]CodeResources/);
		assert.match(result.errors.join("\n"), /no resources but signature indicates they must be present/);
	});
});

test("资源封印存在但 codesign 判失败时仍然判红（封印可能存在而签名无效）", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac", "PiDeck.app");
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "darwin",
			runCodesign: async () => ({ code: 1, output: "code object is not signed at all" }),
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /codesign .* 失败（rc=1）/);
		assert.match(result.errors.join("\n"), /not signed at all/);
	});
});

test("release 下没有 .app 时判红（打包链路没产出可验对象，不能当通过）", async () => {
	await withTempRelease(async (release) => {
		await mkdir(join(release, "mac-arm64"), { recursive: true });
		await put(join(release, "PiDeck-0.9.0-arm64.dmg"), "dmg");
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign: async () => okCodesign() });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /没找到任何 \.app/);
	});
});

test("非 macOS 宿主直接判红，不假装通过", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac-arm64", "PiDeck.app");
		let called = false;
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "linux",
			runCodesign: async () => {
				called = true;
				return okCodesign();
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /只能在 macOS 上运行/);
		assert.equal(called, false);
	});
});

test("多架构产物逐个检查：arm64 合格、x64 未签名时整体判红", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac-arm64", "PiDeck.app");
		const x64 = await createApp(release, "mac", "PiDeck Dev.app", { sealed: false });
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "darwin",
			runCodesign: async (args) => (args.includes(x64) ? { code: 1, output: UNSIGNED_OUTPUT } : okCodesign()),
		});
		assert.equal(result.ok, false);
		assert.equal(result.apps.length, 2);
		assert.equal(result.apps.filter((app) => app.sealed).length, 1);
	});
});

test("目录发现只认 mac* 输出目录：win/linux 产物目录被忽略", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac-universal", "PiDeck.app");
		await createApp(release, "win-unpacked", "PiDeck.exe"); // 非 mac 目录，忽略
		await createApp(release, "linux-unpacked", "PiDeck.app"); // 名字像 app 但目录不是 mac*
		const apps = await findMacApps(release);
		// 用 relative 剥前缀并归一为 /：Windows 上 join 产出反斜杠，硬编码 `${release}/` 剥不掉（2026-10 Windows 全量红）
		assert.deepEqual(
			apps.map((app) => relative(release, app).split("\\").join("/")),
			["mac-universal/PiDeck.app"],
		);
	});
});

// 接线守卫：门禁脚本必须挂在真正打包 mac 产物的 workflow 上，否则改了脚本也没人跑。
// 正则空白容忍（AGENTS.md：格式调整不得让契约测试假红）。
// build-dev.yml 同样在 macOS runner 上出包并上传 prerelease——dev 通道只靠 dist-dev.js 浅合并
// 继承 identity，配置回归时若无门禁会再次静默发坏包（#347 同形态）。
test("四个 mac 打包 workflow 都调用签名门禁脚本", async () => {
	for (const file of ["release.yml", "build-macos.yml", "mac-test-build.yml", "build-dev.yml"]) {
		const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
		assert.match(workflow, /node\s+scripts\/verify-mac-signature\.mjs/, `${file} 未接入 scripts/verify-mac-signature.mjs`);
	}
});

test("release.yml 的 mac 签名门禁只跑在 macos job（其它平台没有 .app，跑了必然假红）", async () => {
	const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const step = workflow.slice(workflow.indexOf("Verify macOS bundle signature"));
	assert.match(step, /if:\s*matrix\.platform\s*==\s*'macos'/);
});
