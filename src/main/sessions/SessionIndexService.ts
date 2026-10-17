/**
 * Go session-index sidecar 的宿主侧客户端（跨会话全文搜索）。
 *
 * 为什么存在：历史会话读取在主进程为防 OOM 全线分页/限流（boundedEntryPage
 * 等），全文检索架构上不存在；侧栏搜索只匹配标题+预览+路径。本服务拉起
 * Go sidecar（native/session-index，预提取正文语料+多核分片扫描）补齐
 * 「在全部历史会话正文里搜词」的能力。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、
 * 绝不抛异常——sidecar 缺失/崩溃/超时一律回退现有标题过滤（fail-open，
 * 与 XueIndexService 同哲学）。二进制未构建（贡献者未跑 build:session-index）
 * 是最常见形态，spawn 立即失败代价可忽略。
 *
 * 生命周期纪律（清理路径唯一归属地，参照 XueIndexService）：
 * - roots 签名变化（settings sessionDir 变更）→ 杀旧进程按新 roots 重拉；
 * - boot 超时（真实规模全量首建约 13s，慢盘/杀毒可拖更久；60s 上限）/
 *   进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）。
 * - 所有子进程事件回调核对进程身份，旧进程迟到事件只吸收。
 *
 * 本模块不 import electron（路径/根目录解析由装配层注入），tests 可用
 * PassThrough 假子进程直接驱动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SessionSearchResult } from "../../shared/types";

/** 与 native/session-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退标题过滤）。 */
export const SESSION_INDEX_PROTOCOL_VERSION = 1;

/**
 * boot 上限：本机真实规模（1032 会话/1.67GB 源）全量首建约 13s；二次启动
 * 走快照增量仅数十毫秒。60s 覆盖冷盘+杀毒实时扫描的极端形态，超时降级。
 */
const DEFAULT_BOOT_TIMEOUT_MS = 60_000;
/**
 * 单次检索上限：29MB 级语料毫秒级完成；冷页缓存的大语料可能到秒级。
 * 30s 只是对进程卡死的保险，超时由调用方降级。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** stdout 单行上限：搜索响应（20 会话 × 3 命中）远小于此，防异常帧撑爆内存。 */
export const MAX_SESSION_INDEX_LINE_CHARS = 4 * 1024 * 1024;

export type SessionIndexLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

export type SessionIndexFailureReason = "binary-missing" | "boot-failed" | "timeout" | "protocol" | "request-failed" | "not-ready";

export type SessionIndexCallResult<T> = { ok: true; value: T } | { ok: false; reason: SessionIndexFailureReason; message: string };

export type SessionIndexStats = {
	changedFiles: number;
	removedFiles: number;
	sessionCount: number;
	entryCount: number;
	corpusBytes: number;
	compactReason?: string;
};

export type SessionIndexServiceOptions = {
	/** 语料目录（userData 下专属目录，存 corpus.bin 与 state 快照）。 */
	corpusDir: string;
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: SessionIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: typeof spawn;
	timeouts?: { boot?: number; request?: number };
};

type ReadyFrame = { type: "ready"; protocolVersion?: number; sessionCount?: number; entryCount?: number; corpusBytes?: number; indexMs?: number; fullRebuild?: boolean };
type ResponseFrame = { type: "response"; id?: number; ok?: boolean; result?: unknown; error?: string };
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

export class SessionIndexService {
	private readonly corpusDir: string;
	private readonly resolveBinaryPath: () => string | null;
	private readonly logger?: SessionIndexLogger;
	private readonly spawnFn: typeof spawn;
	private readonly bootTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	private disposed = false;
	private child: ChildProcessWithoutNullStreams | null = null;
	private childReady: Promise<"ready" | "dead"> | null = null;
	/** 当前进程的 roots 签名（\0 join）；变化即重启，防止索引口径漂移。 */
	private childRootsKey: string | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private stderrTail: string[] = [];
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;

	constructor(options: SessionIndexServiceOptions) {
		this.corpusDir = options.corpusDir;
		this.resolveBinaryPath = options.resolveBinaryPath;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS;
		this.requestTimeoutMs = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * 全文检索。roots 决定扫描口径，与当前进程不一致时自动重启（settings
	 * sessionDir 变更场景）。boot 期间（首建索引可达数十秒）返回 not-ready，
	 * 调用方降级标题过滤——不阻塞等待，索引就绪后下一次调用自然生效。
	 */
	async search(roots: string[], query: string, limit?: number, perSession?: number): Promise<SessionIndexCallResult<SessionSearchResult>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<SessionSearchResult>({ cmd: "search", query, limit, perSession });
	}

	/** 增量重扫（新会话文件/mtime 变化/删除）。渲染层搜索前或定期触发。 */
	async refresh(roots: string[]): Promise<SessionIndexCallResult<SessionIndexStats>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<SessionIndexStats>({ cmd: "refresh" });
	}

	/** 应用退出时由装配层（quitCleanup）调用：结算 pending 并停掉子进程。 */
	dispose(): void {
		this.disposed = true;
		this.settleAll("protocol", "会话搜索服务已停止");
		this.killChild("dispose");
	}

	// ------------------------------------------------------------------
	// 子进程生命周期
	// ------------------------------------------------------------------

	private ensureChild(roots: string[]): Promise<SessionIndexCallResult<true> | { ok: false; reason: SessionIndexFailureReason; message: string }> {
		if (this.disposed) return Promise.resolve({ ok: false, reason: "boot-failed", message: "会话搜索服务已停止" });
		if (roots.length === 0) return Promise.resolve({ ok: false, reason: "not-ready", message: "无会话根目录" });
		const rootsKey = roots.join("\0");
		if (this.child && this.childRootsKey === rootsKey && this.childReady) {
			return this.childReady.then((state) => (state === "ready" ? { ok: true as const, value: true as const } : { ok: false as const, reason: "boot-failed" as const, message: "会话搜索进程启动失败" }));
		}
		if (this.child) {
			// roots 变化重启：在途请求一并结算（调用方降级标题过滤，语义安全）
			this.settleAll("protocol", "会话根目录已变更，搜索进程重启");
			this.killChild("roots-swap");
		}
		const binaryPath = this.resolveBinaryPath();
		if (!binaryPath) {
			return Promise.resolve({ ok: false, reason: "binary-missing", message: "会话搜索二进制不存在（未构建或未随包分发）" });
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnFn(binaryPath, [this.corpusDir, ...roots], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}) as ChildProcessWithoutNullStreams;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger?.warn(`session-index spawn 失败：${message}`);
			return Promise.resolve({ ok: false, reason: "binary-missing", message: "会话搜索进程启动失败" });
		}
		this.child = child;
		this.childRootsKey = rootsKey;
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
			this.logger?.error(`session-index 进程错误：${error.message}`);
			this.markChildDead("boot-failed", "会话搜索进程启动失败");
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			this.logger?.warn(`session-index 退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
			// 语料目录不可写等环境级失败进程 exit 1：结算全部 pending 触发降级
			this.markChildDead("boot-failed", `会话搜索进程退出（code ${code ?? "null"}）`);
		});
		const bootStartedAt = Date.now();
		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			// ready 与超时同拍到达时只认先到的终局（XueIndexService 同款坑）
			let settled = false;
			const bootTimer = setTimeout(() => {
				setImmediate(() => {
					if (settled) return;
					settled = true;
					this.logger?.warn(`session-index boot 超时（${Date.now() - bootStartedAt}ms）`);
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
		return ready.then((state) => (state === "ready" ? { ok: true as const, value: true as const } : { ok: false as const, reason: "boot-failed" as const, message: "会话搜索进程启动失败" }));
	}

	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		this.childRootsKey = null;
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		this.notifyDead();
		return child;
	}

	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止 session-index（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程已死时 kill 抛错可忽略；close 监听负责收尾
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.logger?.error(`session-index 输入管道错误：${error.message}`);
		this.killChild("stdin-error");
		this.settleAll("protocol", "会话搜索进程管道已关闭");
	}

	private markChildDead(reason: SessionIndexFailureReason, message: string): void {
		this.teardownChild();
		this.settleAll(reason, message);
	}

	// ------------------------------------------------------------------
	// 请求与消息泵
	// ------------------------------------------------------------------

	private async request<T>(frame: { cmd: string; query?: string; limit?: number; perSession?: number }): Promise<SessionIndexCallResult<T>> {
		const child = this.child;
		if (!child) return { ok: false, reason: "boot-failed", message: "会话搜索进程不可用" };
		const id = this.nextId++;
		return new Promise<SessionIndexCallResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.logger?.warn(`session-index 请求超时：cmd=${frame.cmd} id=${id}`);
				resolve({ ok: false, reason: "timeout", message: "会话搜索超时" });
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
				this.logger?.warn(`session-index 指令写入失败：${message}`);
				resolve({ ok: false, reason: "protocol", message: "会话搜索进程不可用" });
			}
		});
	}

	private consumeStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (this.buffer.length > MAX_SESSION_INDEX_LINE_CHARS) {
			const dropped = this.buffer.length;
			this.buffer = "";
			this.logger?.error(`session-index stdout 行缓冲溢出：丢弃 ${dropped} 字节`);
			this.killChild("protocol");
			this.settleAll("protocol", "会话搜索响应异常");
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
			this.logger?.warn(`session-index stdout 非法行（已忽略）：${JSON.stringify(rawLine.slice(0, 200))}`);
			return;
		}
		if (record.type === "ready") {
			const ready = record as ReadyFrame;
			if (ready.protocolVersion !== SESSION_INDEX_PROTOCOL_VERSION) {
				this.logger?.error(`session-index 协议版本不匹配：sidecar=${String(ready.protocolVersion)} 宿主=${SESSION_INDEX_PROTOCOL_VERSION}`);
				this.killChild("protocol-version");
				this.settleAll("protocol", "会话搜索协议版本不匹配");
				return;
			}
			this.logger?.info(`session-index ready：${String(ready.sessionCount ?? "?")} 会话 / ${String(ready.entryCount ?? "?")} 条正文，语料 ${String(ready.corpusBytes ?? "?")}B，索引 ${String(ready.indexMs ?? "?")}ms${ready.fullRebuild ? "（全量重建）" : ""}`);
			this.notifyReady();
			return;
		}
		if (record.type !== "response") return;
		const response = record as ResponseFrame;
		const pending = this.pending.get(response.id ?? -1);
		if (!pending) return; // 迟到响应（超时已结算）直接丢弃
		this.pending.delete(response.id ?? -1);
		clearTimeout(pending.timer);
		if (response.ok) {
			(pending.resolve as (value: SessionIndexCallResult<unknown>) => void)({ ok: true, value: response.result ?? null });
		} else {
			this.logger?.warn(`session-index 请求失败：${response.error ?? "unknown"}`);
			(pending.resolve as (value: SessionIndexCallResult<unknown>) => void)({ ok: false, reason: "request-failed", message: response.error ?? "会话搜索失败" });
		}
	}

	private settleAll(reason: SessionIndexFailureReason, message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			(pending.resolve as (value: SessionIndexCallResult<unknown>) => void)({ ok: false, reason, message });
		}
		this.pending.clear();
	}
}
