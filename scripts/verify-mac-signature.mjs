#!/usr/bin/env node

// macOS 包签名门禁（#347 回归守卫）。
//
// 背景：electron-builder 26.15 起，找不到签名证书时不再回退 ad-hoc——26.8.1 的
// macPackager.fallBackToAdhoc（arm64/universal 自动 `identity: "-"`）已被删除，
// app-builder-lib/scheme.json 的 identity 说明也写明「no automatic ad-hoc fallback」。
// 仓库没有任何 Apple 证书/密钥，于是签名被静默跳过、CI 依旧绿灯，产出的 PiDeck.app
// 只剩 Electron 上游的 linker 签章：没有 Contents/_CodeSignature、Info.plist 未封印
// （CodeDirectory identifier 仍是 Electron、nSpecialSlots=0），Apple Silicon 上启动即失败
// （进程停在 _dyld_start，也没有「仍要打开」入口）。修复是 package.json build.mac.identity: "-"
// 显式 ad-hoc，本脚本是它的产物级判定——配置改对了但打包被跳过时，这里必须红。
//
// 判定标准来自官方包实测（v0.8.0 arm64 dmg 全部通过；v0.9.0 arm64 zip 缺封印且
// codesign 报 "code has no resources but signature indicates they must be present"）：
//   1. release/mac*/.app 必须存在（没有 .app 说明打包链路已经出问题，直接判失败）；
//   2. <app>/Contents/_CodeSignature/CodeResources 必须存在且非空（bundle 资源封印）；
//   3. `codesign --verify --deep --strict` 退出码必须为 0（--deep 会一并校验
//      Frameworks 下的 Electron Framework 与 Helper.app，覆盖改名后未重签的情况）。
// 只在 macOS 上运行：没有 codesign 的宿主直接判失败，不允许「跳过了还当通过」。

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RESOURCE_SEAL = join("Contents", "_CodeSignature", "CodeResources");
// electron-builder 按架构分输出目录：mac（默认/universal 之外的单个 arch）、mac-arm64、mac-universal。
// .app 目录名随通道变化（PiDeck / PiDeck Dev），所以只拿 mac* 当锚点。
const MAC_OUTPUT_DIR = /^mac(-.*)?$/;

async function isNonEmptyFile(path) {
	try {
		const info = await stat(path);
		return info.isFile() && info.size > 0;
	} catch {
		return false;
	}
}

function tail(text, limit = 800) {
	const trimmed = String(text ?? "").trim();
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** 默认 codesign 执行器：把退出码与输出交回门禁判定，自身不抛异常（缺 codesign 也走同一分支）。 */
async function defaultRunCodesign(args) {
	try {
		const { stdout, stderr } = await execFileAsync("codesign", args, { maxBuffer: 8 * 1024 * 1024 });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const code = typeof error?.code === "number" ? error.code : 1;
		return { code, output: `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}` };
	}
}

/**
 * 收集 release/mac* 目录下的 .app。
 * 导出是为让测试在不依赖 macOS 的前提下覆盖目录发现逻辑。
 */
export async function findMacApps(releaseDir) {
	let entries;
	try {
		entries = await readdir(releaseDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const apps = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !MAC_OUTPUT_DIR.test(entry.name)) continue;
		const dir = join(releaseDir, entry.name);
		for (const child of await readdir(dir, { withFileTypes: true })) {
			if (child.isDirectory() && child.name.endsWith(".app")) apps.push(join(dir, child.name));
		}
	}
	return apps.sort();
}

/**
 * 校验 release 目录下每个 mac 产物的代码签名。
 * `platform`/`runCodesign` 可注入，测试因此在 Linux 上也能覆盖全部判定分支。
 */
export async function verifyMacSignature({ releaseDir = join(process.cwd(), "release"), platform = process.platform, runCodesign = defaultRunCodesign } = {}) {
	const root = resolve(releaseDir);
	const errors = [];
	const apps = [];

	if (platform !== "darwin") {
		return { ok: false, releaseDir: root, apps, errors: [`macOS 签名门禁需要 codesign，只能在 macOS 上运行（当前宿主：${platform}）`] };
	}

	const appPaths = await findMacApps(root);
	if (appPaths.length === 0) {
		return { ok: false, releaseDir: root, apps, errors: [`在 ${root} 下没找到任何 .app（期望 release/mac*/*.app），无法验证签名`] };
	}

	for (const appPath of appPaths) {
		const sealPath = join(appPath, RESOURCE_SEAL);
		const sealed = await isNonEmptyFile(sealPath);
		if (!sealed) errors.push(`缺少资源封印 ${sealPath}：bundle 未做代码签名（签名被跳过时就是这个状态）`);

		const args = ["--verify", "--deep", "--strict", "--verbose=2", appPath];
		const { code, output } = await runCodesign(args);
		if (code !== 0) errors.push(`codesign ${args.slice(0, 4).join(" ")} 失败（rc=${code}）：${tail(output)}`);
		apps.push({ path: appPath, resourceSeal: sealPath, sealed, codesignExitCode: code });
	}

	return { ok: errors.length === 0, releaseDir: root, apps, errors };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--release-dir") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options.releaseDir = value;
			index += 1;
		} else if (arg === "--help") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log("Usage: node scripts/verify-mac-signature.mjs [--release-dir <path>] [--json]");
		} else {
			const result = await verifyMacSignature(options);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else if (result.ok) console.log(`macOS bundles signed (${result.apps.length}): ${result.apps.map((app) => app.path).join(", ")}`);
			else {
				console.error(`macOS signature verification failed (${result.errors.length}):`);
				for (const error of result.errors) console.error(`- ${error}`);
				console.error('提示：无 Apple 证书时 package.json build.mac.identity 必须为 "-"（显式 ad-hoc），见 docs/release-process.md「打包验证」。');
			}
			if (!result.ok) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`macOS signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
