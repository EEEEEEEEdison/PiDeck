/**
 * Go xue-index sidecar 的宿主侧客户端（提示词库检索提速通道）。
 *
 * 职责：按 dbPath 拉起/复用常驻 Go 进程（`resources/xue-index/bin/xue-index[.exe]`，
 * 由 scripts/build-xue-index.mjs 构建、extraResources 分发），把 list/get 编成
 * NDJSON 指令发给 stdin，按 id 配对 stdout 响应帧。
 *
 * 失败语义（调用方 XuePromptManager 依赖这一点做降级）：任何失败都以
 * `{ ok: false, reason }` 返回，绝不抛异常——sidecar 缺失/崩溃/超时一律由
 * 调用方回退 sql.js 路径，不影响商店可用性。二进制不存在（贡献者未跑
 * build:xue-index）是最常见形态，spawn 立即失败，代价可忽略。
 *
 * 生命周期纪律（参照 EnhancePromptService，本文件是清理路径唯一归属地）：
 * - dbPath 变化（远程库更新后缓存文件被原子替换）→ 杀旧进程按新路径重拉；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算全部 pending 并标记 dead，
 *   下次调用重试新进程；dispose → 结算 + 杀进程。
 * - 所有子进程事件回调核对进程身份（this.child === child），旧进程的迟到
 *   事件只吸收，不污染新进程的状态。
 *
 * 本模块不 import electron（路径解析、二进制定位由装配层/调用方注入），
 * 保证 tests 能用 PassThrough 假子进程直接驱动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { YaoPromptCategory, YaoPromptItem } from "../../shared/types";

/** 与 native/xue-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退 sql.js）。 */
export const XUE_INDEX_PROTOCOL_VERSION = 1;

/**
 * boot 上限：正常加载 4012 条约 140ms，但 Windows 首次运行杀毒实时扫描可让
 * 首次启动拖到数秒；15s 足够宽且不会让用户端降级等待过久（超时即回退）。
 */
const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
/** 单次检索上限：内存内过滤毫秒级，10s 只是对进程卡死的保险。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** stdout 单行上限：全量形态的响应帧（4000+ 条目）可达数 MB，与 Go 侧 16MB scanner 上限一致。 */
export const MAX_XUE_INDEX_LINE_CHARS = 16 * 1024 * 1024;

export type XueIndexLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

/** 覆盖层条目（宿主把官方模板热更新目录解析成此结构随请求下发，Go 侧无状态）。 */
export type XueIndexOverlayEntry = {
	slug: string;
	title?: string;
	description?: string;
	category?: string;
	content: string;
};

export type XueIndexListParams = {
	category?: string;
	search?: string;
	page?: number;
	pageSize?: number;
	overlay?: XueIndexOverlayEntry[];
};

/** Go 侧单条明文文档（detail 的 db 部分；fullContent 由 XuePromptManager 组装）。 */
export type XueIndexDoc = {
	slug: string;
	url: string;
	title: string;
	category: string;
	content: string;
	description: string;
};

/** Go 侧 list 结果：分页形态带 total/page/pageSize，全量形态省略（omitempty）。 */
export type XueIndexListResult = {
	categories: YaoPromptCategory[];
	prompts: YaoPromptItem[];
	total?: number;
	page?: number;
	pageSize?: number;
};

export type XueIndexFailureReason = "binary-missing" | "boot-failed" | "timeout" | "protocol" | "request-failed";

export type XueIndexCallResult<T> = { ok: true; value: T } | { ok: false; reason: XueIndexFailureReason; message: string };

export type XueIndexServiceOptions = {
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未打包），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: XueIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: typeof spawn;
	timeouts?: { boot?: number; request?: number };
};

type ResponseFrame = { type: "response"; id?: number; ok?: boolean; result?: unknown; error?: string };
type ReadyFrame = { type: "ready"; protocolVersion?: number; count?: number; loadMs?: number };
type HostRecord = ReadyFrame | ResponseFrame | { type: string };

type PendingRequest = {
	id: number;
	resolve: (value: never) => void;
	timer: NodeJS.Timeout;
};

function parseRecord(line: string): HostRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return typeof (parsed as { type?: unknown }).type === "string" ? (parsed as HostRecord) : undefined;
	} catch {
		return undefined;
	}
}

function isResponseFrame(record: HostRecord): record is ResponseFrame {
	return record.type === "response";
}

function isReadyFrame(record: HostRecord): record is ReadyFrame {
	return record.type === "ready";
}

export class XueIndexService {
	private readonly resolveBinaryPath: () => string | null;
	private readonly logger?: XueIndexLogger;
	private readonly spawnFn: typeof spawn;
	private readonly bootTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	private disposed = false;
	private child: ChildProcessWithoutNullStreams | null = null;
	private childReady: Promise<"ready" | "dead"> | null = null;
	private childDbPath: string | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private stderrTail: string[] = [];
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;

	constructor(options: XueIndexServiceOptions) {
		this.resolveBinaryPath = options.resolveBinaryPath;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS;
		this.requestTimeoutMs = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * 检索。dbPath 决定 sidecar 装载哪个库文件；与当前进程不一致时自动重启
	 * （远程库更新 → 缓存原子替换 → 下一次 list 自然换库，无需全局协调）。
	 */
	async list(dbPath: string, params: XueIndexListParams): Promise<XueIndexCallResult<XueIndexListResult>> {
		const boot = await this.ensureChild(dbPath);
		if (!boot.ok) return boot;
		return this.request<XueIndexListResult>({ cmd: "list", params });
	}

	/** 取单条明文；未命中时 value 为 null（区别于 ok:false 的通道失败）。 */
	async get(dbPath: string, slug: string): Promise<XueIndexCallResult<XueIndexDoc | null>> {
		const boot = await this.ensureChild(dbPath);
		if (!boot.ok) return boot;
		return this.request<XueIndexDoc | null>({ cmd: "get", slug });
	}

	/** 应用退出/重置时由装配层调用：结算全部 pending 并停掉子进程。 */
	dispose(): void {
		this.disposed = true;
		this.settleAll("protocol", "提示词检索服务已停止");
		this.killChild("dispose");
	}

	// ------------------------------------------------------------------
	// 子进程生命周期
	// ------------------------------------------------------------------

	private ensureChild(dbPath: string): Promise<XueIndexCallResult<true> | { ok: false; reason: XueIndexFailureReason; message: string }> {
		if (this.disposed) return Promise.resolve({ ok: false, reason: "boot-failed", message: "提示词检索服务已停止" });
		// 复用条件：进程活着且装载的就是目标库；db 换文件（远程更新）必须重启
		if (this.child && this.childDbPath === dbPath && this.childReady) {
			return this.childReady.then((state) => (state === "ready" ? { ok: true as const, value: true as const } : { ok: false as const, reason: "boot-failed" as const, message: "提示词检索进程启动失败，已回退内置检索" }));
		}
		if (this.child) {
			// 换库重启：旧进程上在途请求一并结算（调用方回退 sql.js，语义安全）
			this.settleAll("protocol", "提示词库已更新，检索进程重启");
			this.killChild("db-swap");
		}
		const binaryPath = this.resolveBinaryPath();
		if (!binaryPath) {
			return Promise.resolve({ ok: false, reason: "binary-missing", message: "提示词检索二进制不存在（未构建或未随包分发）" });
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnFn(binaryPath, [dbPath], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}) as ChildProcessWithoutNullStreams;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger?.warn(`xue-index spawn 失败：${message}`);
			return Promise.resolve({ ok: false, reason: "binary-missing", message: "提示词检索进程启动失败" });
		}
		this.child = child;
		this.childDbPath = dbPath;
		this.stderrTail = [];
		this.pending.clear();
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		child.stdin.on("error", (error: Error) => this.handleStdinError(child, error));
		child.stdout.on("data", (chunk: Buffer) => {
			if (this.child === child) this.consumeStdout(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (this.child !== child) return;
			const line = chunk.toString("utf8").trim();
			if (line) this.stderrTail.push(line);
			if (this.stderrTail.length > 10) this.stderrTail.shift();
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.logger?.error(`xue-index 进程错误：${error.message}`);
			this.markChildDead("boot-failed", "提示词检索进程启动失败");
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			this.logger?.warn(`xue-index 退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
			// db 打不开时进程 exit 1：属环境级失败，结算全部 pending 触发降级
			this.markChildDead("boot-failed", `提示词检索进程退出（code ${code ?? "null"}）`);
		});
		const bootStartedAt = Date.now();
		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			// ready 与超时同拍到达时只认先到的终局（EnhancePromptService 同款坑）
			let settled = false;
			const bootTimer = setTimeout(() => {
				// 定时器阶段先于 poll 阶段：先退一个事件循环回合让已写出的 ready 走完管道
				setImmediate(() => {
					if (settled) return;
					settled = true;
					this.logger?.warn(`xue-index boot 超时（${Date.now() - bootStartedAt}ms）`);
					resolveReady("dead");
					this.killChild("boot-timeout");
				});
			}, this.bootTimeoutMs);
			this.notifyReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				resolveReady("ready");
			};
			this.notifyDead = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				resolveReady("dead");
			};
		});
		this.childReady = ready;
		return ready.then((state) => (state === "ready" ? { ok: true as const, value: true as const } : { ok: false as const, reason: "boot-failed" as const, message: "提示词检索进程启动失败，已回退内置检索" }));
	}

	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		this.childDbPath = null;
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		this.notifyDead();
		return child;
	}

	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止 xue-index（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程已死时 kill 抛错可忽略；close 监听负责收尾
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.logger?.error(`xue-index 输入管道错误：${error.message}`);
		this.killChild("stdin-error");
		this.settleAll("protocol", "提示词检索进程管道已关闭");
	}

	private markChildDead(reason: XueIndexFailureReason, message: string): void {
		this.teardownChild();
		this.settleAll(reason, message);
	}

	// ------------------------------------------------------------------
	// 请求与消息泵
	// ------------------------------------------------------------------

	private async request<T>(frame: { cmd: string; params?: unknown; slug?: string }): Promise<XueIndexCallResult<T>> {
		const child = this.child;
		if (!child) return { ok: false, reason: "boot-failed", message: "提示词检索进程不可用" };
		const id = this.nextId++;
		return new Promise<XueIndexCallResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.logger?.warn(`xue-index 请求超时：cmd=${frame.cmd} id=${id}`);
				resolve({ ok: false, reason: "timeout", message: "提示词检索超时" });
			}, this.requestTimeoutMs);
			this.pending.set(id, {
				id,
				timer,
				resolve: resolve as (value: never) => void,
			});
			try {
				child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				const message = error instanceof Error ? error.message : String(error);
				this.logger?.warn(`xue-index 指令写入失败：${message}`);
				resolve({ ok: false, reason: "protocol", message: "提示词检索进程不可用" });
			}
		});
	}

	private consumeStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (this.buffer.length > MAX_XUE_INDEX_LINE_CHARS) {
			const dropped = this.buffer.length;
			this.buffer = "";
			this.logger?.error(`xue-index stdout 行缓冲溢出：丢弃 ${dropped} 字节`);
			this.killChild("protocol");
			this.settleAll("protocol", "提示词检索响应异常");
			return;
		}
		for (;;) {
			const lf = this.buffer.indexOf("\n");
			if (lf === -1) break;
			const line = this.buffer.slice(0, lf);
			this.buffer = this.buffer.slice(lf + 1);
			if (!line.trim()) continue;
			this.handleRecord(parseRecord(line), line);
		}
	}

	private handleRecord(record: HostRecord | undefined, rawLine: string): void {
		if (!record) {
			this.logger?.warn(`xue-index stdout 非法行（已忽略）：${JSON.stringify(rawLine.slice(0, 200))}`);
			return;
		}
		if (isReadyFrame(record)) {
			if (record.protocolVersion !== XUE_INDEX_PROTOCOL_VERSION) {
				this.logger?.error(`xue-index 协议版本不匹配：sidecar=${String(record.protocolVersion)} 宿主=${XUE_INDEX_PROTOCOL_VERSION}`);
				this.killChild("protocol-version");
				this.settleAll("protocol", "提示词检索协议版本不匹配");
				return;
			}
			this.logger?.debug(`xue-index ready：${String(record.count ?? "?")} 条，加载 ${String(record.loadMs ?? "?")}ms`);
			this.notifyReady();
			return;
		}
		if (!isResponseFrame(record)) return;
		const pending = this.pending.get(record.id ?? -1);
		if (!pending) return; // 迟到响应（超时已结算）直接丢弃
		this.pending.delete(record.id ?? -1);
		clearTimeout(pending.timer);
		if (record.ok) {
			(pending.resolve as (value: XueIndexCallResult<unknown>) => void)({ ok: true, value: record.result ?? null });
		} else {
			this.logger?.warn(`xue-index 请求失败：${record.error ?? "unknown"}`);
			(pending.resolve as (value: XueIndexCallResult<unknown>) => void)({ ok: false, reason: "request-failed", message: record.error ?? "提示词检索失败" });
		}
	}

	private settleAll(reason: XueIndexFailureReason, message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			(pending.resolve as (value: XueIndexCallResult<unknown>) => void)({ ok: false, reason, message });
		}
		this.pending.clear();
	}
}
