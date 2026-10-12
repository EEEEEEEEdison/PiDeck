// billion-context 宿主插件面板：只做「看状态 / 启停 / 开面板」三件事。
// 服务能力由 PiDeck 主进程实现（命令、参数、端口都是主进程常量），本页面只能点名 service id。
const SERVICE_ID = "billion-context";
const BUSY_TIMEOUT_MS = 60_000;

const COPY = {
	"zh-CN": {
		running: "运行中",
		stopped: "未运行",
		notAvailable: "不可用",
		start: "启动",
		stop: "停止",
		open: "打开面板",
		starting: "启动中…",
		stopping: "停止中…",
		installHint: "未检测到可用的 bili 命令，请先全局安装：npm i -g billion-context",
		stoppedHint: "服务未运行。面板是代理进程自带的，不跑就没有面板。",
		noUiHint: "服务已运行但未报告端口，无法确定面板地址。",
		modalHint: "面板只监听 127.0.0.1 且无鉴权，只在本机浏览器访问；不要暴露到公网或局域网。",
		reasons: {
			"service-unavailable": "PiDeck 未实现该服务的适配器。",
			"service-not-running": "服务未运行。",
			"permission-denied": "该插件未被授权控制此服务。",
			"plugin-revoked": "插件授权已失效，请重新启用插件。",
			"rate-limited": "操作过于频繁，请稍后再试。",
			"cli-missing": "未找到 bili 命令，请先全局安装 billion-context。",
			"cli-failed": "bili 命令执行失败。",
			"invalid-report": "bili doctor 输出无法解析。",
			"start-failed": "启动命令未能执行。",
			"start-timeout": "已发出启动命令，但 20 秒内未检测到服务进程。",
			"stop-failed": "停止失败：进程可能已退出或权限不足。",
			"invalid-request": "请求格式不被接受。",
		},
	},
	"en-US": {
		running: "Running",
		stopped: "Not running",
		notAvailable: "Unavailable",
		start: "Start",
		stop: "Stop",
		open: "Open panel",
		starting: "Starting…",
		stopping: "Stopping…",
		installHint: "No usable bili command was found. Install it globally: npm i -g billion-context",
		stoppedHint: "The service is not running. The panel ships with the proxy process, so there is no panel without it.",
		noUiHint: "The service is running but reported no port, so the panel URL is unknown.",
		modalHint: "The panel listens on 127.0.0.1 only and has no authentication — local browsers only. Never expose the port to a network.",
		reasons: {
			"service-unavailable": "PiDeck has no adapter for this service.",
			"service-not-running": "The service is not running.",
			"permission-denied": "This plugin is not authorized to control that service.",
			"plugin-revoked": "The plugin authorization is no longer valid. Re-enable the plugin.",
			"rate-limited": "Too many requests. Try again shortly.",
			"cli-missing": "The bili command was not found. Install billion-context globally.",
			"cli-failed": "The bili command failed.",
			"invalid-report": "Could not parse the bili doctor output.",
			"start-failed": "The start command could not be executed.",
			"start-timeout": "The start command ran, but no service process appeared within 20 seconds.",
			"stop-failed": "Stop failed: the process may already be gone, or permission was denied.",
			"invalid-request": "The request shape was rejected.",
		},
	},
};

const el = (id) => document.getElementById(id);
let copy = COPY["zh-CN"];
let busy = false;
let timer;

function say(message) {
	const node = el("message");
	node.textContent = message || "";
	node.hidden = !message;
}

/** 原因码只做查表展示：未知码原样显示，方便对着开发指南排查。 */
function reasonText(code) {
	return copy.reasons[code] || code || "";
}

function errorText(error) {
	return reasonText(typeof error?.message === "string" ? error.message : "");
}

function paint(status) {
	const available = status.available !== false;
	const running = status.running === true;
	el("dot").dataset.state = !available ? "missing" : running ? "running" : "stopped";
	el("status").textContent = !available ? copy.notAvailable : running ? copy.running : copy.stopped;
	el("pid").textContent = running && status.pid ? String(status.pid) : "—";
	el("version").textContent = status.version || "—";
	el("ui").textContent = status.uiUrl || "—";
	el("start").disabled = busy || !available || running;
	el("stop").disabled = busy || !running;
	el("open").disabled = busy || !running || !status.uiUrl;
	el("note").textContent = !available ? copy.installHint : running ? (status.uiUrl ? copy.modalHint : copy.noUiHint) : copy.stoppedHint;
	// 状态本身就是「不可用」时，把原因码摆在明面上，而不是只把按钮置灰。
	say(available ? "" : reasonText(status.reason));
}

function setBusy(next, label) {
	busy = next;
	window.clearTimeout(timer);
	if (next) {
		// 启停要等进程真的起来/落下，比普通请求慢得多；超时后自己解锁，避免按钮永久卡住。
		timer = window.setTimeout(() => {
			busy = false;
			say(reasonText("start-timeout"));
			void refresh();
		}, BUSY_TIMEOUT_MS);
	}
	if (label) el("status").textContent = label;
}

async function refresh() {
	if (busy) return;
	try {
		paint(await pideck.services.status(SERVICE_ID));
	} catch (error) {
		paint({ available: true, running: false });
		say(errorText(error));
	}
}

async function run(label, action) {
	if (busy) return;
	setBusy(true, label);
	try {
		paint(await action());
	} catch (error) {
		say(errorText(error));
	} finally {
		setBusy(false);
		await refresh();
	}
}

async function main() {
	try {
		const context = await pideck.context.get();
		copy = context?.locale === "en-US" ? COPY["en-US"] : COPY["zh-CN"];
	} catch {
		// context 拿不到就用默认语言，不影响服务操作。
	}
	document.documentElement.lang = copy === COPY["en-US"] ? "en-US" : "zh-CN";
	el("start").textContent = copy.start;
	el("stop").textContent = copy.stop;
	el("open").textContent = copy.open;

	el("refresh").addEventListener("click", () => void refresh());
	el("start").addEventListener("click", () => void run(copy.starting, () => pideck.services.start(SERVICE_ID)));
	el("stop").addEventListener("click", () => void run(copy.stopping, () => pideck.services.stop(SERVICE_ID)));
	el("open").addEventListener("click", () => void run(null, () => pideck.services.openUi(SERVICE_ID)));

	await refresh();
}

if (typeof globalThis.pideck?.services?.status !== "function") {
	// 旧宿主或未授权：明确说出来，而不是留一个永远转圈的按钮。
	paint({ available: true, running: false });
	say(reasonText("service-unavailable"));
} else {
	void main();
}
