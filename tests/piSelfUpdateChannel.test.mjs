/**
 * pi 自更新通道判定（resolvePiSelfUpdateChannel）的纯函数测试。
 *
 * 守的分派规则（2026-10 用户报障）：
 * - bun 全局安装的 pi：pi 自身在 Windows 不支持 bun 自更新，PiDeck 必须代跑 bun；
 * - 旧引导前缀副本（<userData>/pi-runtime/pi-global）：pi 的 npm 自更新在 Windows 不推断
 *   前缀，会装到用户真实全局目录、前缀副本永远停旧，PiDeck 必须带 --prefix 代跑 npm；
 * - 其余形态（npm/pnpm 全局、官方 managed、homebrew、WSL、裸命令名）：交给 pi 自己。
 *
 * bunCommand 的推导规则（2026-10 bun 用户报「更新不了」的回归）：bun 本体在**安装根目录的 bin/**
 * （与全局 shim 同目录），不是与 pi 入口同目录——软链解析后的包路径（…/dist/cli.js）下更不可能。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, win32 } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolvePiSelfUpdateChannel } = loadTsCommonJs("src/main/pi/piSelfUpdateChannel.ts");

test("bun 全局 bin（POSIX 形态）→ bun-global，bunCommand 取同目录的 bun 本体", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.bun/bin/pi", "linux");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "/home/tester/.bun/bin/bun");
	assert.equal(channel.bunInstallRoot, "/home/tester/.bun");
});

test("bun 全局 bin（Windows 形态）→ bun-global，bunCommand 是同目录 bun.exe", () => {
	const channel = resolvePiSelfUpdateChannel(String.raw`C:\Users\tester\.bun\bin\pi.exe`, "win32");
	assert.equal(channel.kind, "bun-global");
	// 分隔符跟随路径自身形态（反斜杠路径用 win32 拼），不是宿主平台。
	assert.equal(channel.bunCommand, win32.join(String.raw`C:\Users\tester\.bun\bin`, "bun.exe"));
	assert.equal(channel.bunInstallRoot, String.raw`C:\Users\tester\.bun`);
});

test("bun 包目录（软链解析后的真实位置）→ bunCommand 取 .bun 根下的 bin/bun，而不是包目录里不存在的 bun", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "linux");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "/home/tester/.bun/bin/bun");
	assert.equal(channel.bunInstallRoot, "/home/tester/.bun");
});

test("自定义 BUN_INSTALL 根（非 .bun 目录）→ bunCommand 取 <root>/bin/bun，并把 <root> 交给调用方设 BUN_INSTALL", () => {
	const channel = resolvePiSelfUpdateChannel("/opt/oven/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "linux");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "/opt/oven/bin/bun");
	assert.equal(channel.bunInstallRoot, "/opt/oven");
});

test("根目录不可识别的 install/global 形态 → 回退裸命令名，且不给 BUN_INSTALL", () => {
	// 相对形态（无盘符/根前缀）拿不到可靠的安装根：宁可交回 PATH 解析，也不猜一个可能装错地方的 BUN_INSTALL。
	const channel = resolvePiSelfUpdateChannel("/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "win32");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, "bun.exe");
	assert.equal(channel.bunInstallRoot, undefined);
});

test("bun 包目录（Windows 形态）→ bunCommand 是 .bun\\bin\\bun.exe", () => {
	const channel = resolvePiSelfUpdateChannel(String.raw`C:\Users\tester\.bun\install\global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`, "win32");
	assert.equal(channel.kind, "bun-global");
	assert.equal(channel.bunCommand, win32.join(String.raw`C:\Users\tester\.bun`, "bin", "bun.exe"));
	assert.equal(channel.bunInstallRoot, String.raw`C:\Users\tester\.bun`);
});

test("旧引导前缀（Windows：<prefix>\\pi.cmd）→ portable-prefix，prefixDir 是当初 --prefix 的值", () => {
	const channel = resolvePiSelfUpdateChannel(String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global\pi.cmd`, "win32");
	assert.equal(channel.kind, "portable-prefix");
	assert.equal(channel.prefixDir, String.raw`C:\Users\tester\AppData\Roaming\pi-desktop-dev\pi-runtime\pi-global`);
});

test("旧引导前缀（POSIX：<prefix>/bin/pi）→ portable-prefix，剥掉 bin/ 层", () => {
	const channel = resolvePiSelfUpdateChannel("/home/tester/.config/pi-desktop/pi-runtime/pi-global/bin/pi", "linux");
	assert.equal(channel.kind, "portable-prefix");
	assert.equal(channel.prefixDir, "/home/tester/.config/pi-desktop/pi-runtime/pi-global");
});

test("npm 全局 / homebrew / 官方 managed / WSL / 裸命令名 → pi-self（pi 自己能正确自更新）", () => {
	for (const command of [String.raw`C:\Users\tester\AppData\Roaming\npm\pi.cmd`, "/opt/homebrew/bin/pi", "/home/tester/.local/bin/pi", "wsl://Ubuntu/usr/local/bin/pi", "pi", ""]) {
		assert.equal(resolvePiSelfUpdateChannel(command, "linux").kind, "pi-self", command);
	}
});

test("运行时 WSL 召唤形态 → pi-self（不能把 WSL 目标的 bun 当成宿主 bun）", () => {
	// 回归（2026-10 评审）：PiLocator.check 返回的 WSL 命令是空格拼接的召唤串，不是 wsl:// 标记；
	// 少了这道守卫，`/home/dev/.bun/bin/pi` 会被识别成 bun 全局安装，然后拿 Windows 宿主的 bun 去装。
	for (const command of [
		"wsl -d Ubuntu-24.04 -u dev /home/dev/.bun/bin/pi",
		"wsl.exe -d Ubuntu-24.04 -u dev /home/dev/.bun/bin/pi",
		String.raw`C:\Windows\System32\wsl.exe -d Ubuntu-24.04 -u dev /home/dev/.bun/bin/pi`,
		// 自定义路径直接粘发行版内路径的 UNC 互操作形态（同样不是本地安装）。
		String.raw`\\wsl.localhost\Ubuntu-24.04\home\dev\.bun\bin\pi`,
		String.raw`\\wsl$\Ubuntu-24.04\home\dev\.bun\bin\pi`,
	]) {
		assert.equal(resolvePiSelfUpdateChannel(command, "win32").kind, "pi-self", command);
	}
});
