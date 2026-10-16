import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import { AppErrorBoundary } from "./components/app/AppErrorBoundary";
import { TooltipProvider } from "./components/ui-shadcn/tooltip";
import { Toaster } from "./components/ui-shadcn/sonner";
import { t } from "./i18n";
import { dismissBootOverlay } from "./utils/bootOverlay";
import { showNotice } from "./utils/notice";
import "./styles.css";

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
	window.piDesktop?.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

/** 将异常压缩成用户可读的短文案，避免 toast 被超长 stack 淹没。 */
function formatRuntimeError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// React 将更新深度异常写到 console.error，而不是抛出可带组件信息的 window error。
// 仅捕获该明确错误并限频记录调用栈，便于定位具体 effect；不改写其他 console 行为。
const originalConsoleError = console.error.bind(console);
let lastUpdateDepthDiagnosticAt = 0;
console.error = (...args: unknown[]) => {
	originalConsoleError(...args);
	const message = args.map((arg) => formatRuntimeError(arg)).join(" ");
	if (!message.includes("Maximum update depth exceeded")) return;
	const now = Date.now();
	if (now - lastUpdateDepthDiagnosticAt < 5000) return;
	lastUpdateDepthDiagnosticAt = now;
	writeStartupLog("error", "Renderer React update depth diagnostic", {
		message,
		stack: new Error("React update depth diagnostic").stack,
		url: window.location.href,
	});
};

// 全局运行时异常：写日志 + toast，避免静默失败或整页无反馈。
window.addEventListener("error", (event) => {
	// 资源加载失败（script/img）也会进 error 事件，但 event.error 通常为空；
	// 这类错误不适合弹业务 toast，只记日志。
	const isResourceError = event.target instanceof HTMLElement;
	// ResizeObserver loop 警告是 Chromium 的良性通知（同一帧内 RO 回调又触发 resize），
	// Streamdown 动画 + resizable panels 组合下常见：只记日志、不弹错误 toast。
	// 日志降到 info：这条会进 EnvironmentDoctor 的「最近 7 天报错」统计，
	// 用 error 级别会让良性噪音顶掉真正的失败信号。
	const isBenignResizeObserverLoop = typeof event.message === "string" && event.message.includes("ResizeObserver loop");
	writeStartupLog(isBenignResizeObserverLoop ? "info" : "error", "Renderer uncaught error", {
		message: event.message,
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
		isResourceError,
		error: event.error instanceof Error ? (event.error.stack ?? event.error.message) : String(event.error ?? ""),
	});
	if (!isResourceError) {
		const message = formatRuntimeError(event.error ?? event.message);
		if (message && !isBenignResizeObserverLoop) {
			showNotice(`${t("app.runtimeErrorToast")}: ${message}`, 6000, "error");
		}
	}
});

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason;
	writeStartupLog("error", "Renderer unhandled rejection", {
		reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
	});
	const message = formatRuntimeError(reason);
	if (message) {
		showNotice(`${t("app.unhandledRejectionToast")}: ${message}`, 6000, "error");
	}
});

writeStartupLog("info", "Renderer bootstrap started", {
	url: window.location.href,
});

const rootElement = document.getElementById("root");
if (!rootElement) {
	writeStartupLog("error", "Renderer root element missing");
	throw new Error("Renderer root element missing");
}

// 极简浮窗模式：URL query mini-overlay=1 时加 CSS 类（强制单栏布局 + 隐藏侧栏/抽屉/标题栏）
const isMiniOverlayMode = new URLSearchParams(window.location.search).get("mini-overlay") === "1";
if (isMiniOverlayMode) {
	document.body.classList.add("mini-overlay-mode");
}

ReactDOM.createRoot(rootElement).render(
	<React.StrictMode>
		<AppErrorBoundary>
			{/* shadcn Tooltip 必须在 Provider 树内使用（#115 U1） */}
			<TooltipProvider>
				<App />
				{/* 全局 toast 出口（#115）：showNotice 经 sonner 在此渲染 */}
				<Toaster />
			</TooltipProvider>
		</AppErrorBoundary>
	</React.StrictMode>,
);

/**
 * React 首次渲染完成只记里程碑，**不在这里撤遮罩**：首帧工作区尚未恢复会话
 * （currentSessionId/sessionTabIds 异步到位），按挂载帧撤除会露出「无会话空态
 * = 引导页」那一帧。撤除时机由内容就绪信号决定（hooks/app/useBootOverlayReady.ts），
 * 这里只保留硬兜底超时——不依赖 rAF（Electron 隐藏/后台窗口可将 rAF 长时间节流），
 * 也保证任何异常路径下已挂载的工作台不会被遮罩永久盖住。
 * 保留 rAF 包裹：此里程碑语义是「首帧已提交」，启动诊断时间线按它读节点。
 */
requestAnimationFrame(() => {
	writeStartupLog("info", "Renderer React tree mounted");
});

window.setTimeout(dismissBootOverlay, 1500);
