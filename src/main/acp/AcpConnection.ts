import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { AcpIncomingRequest, AcpJsonRpcMessage, AcpRpcId, AcpRpcNotification, AcpRpcRequest } from "./acpProtocol";

/** JSON-RPC 调用被 agent 拒绝（响应带 error 对象）。 */
export class AcpRpcError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(`ACP RPC error ${code}: ${message}`);
		this.name = "AcpRpcError";
	}
}

/** 请求超时(agent 未在期限内应答)。typed:上层需区分「回合还在 agent 侧跑,应补发
 *  session/cancel」的超时与普通失败——不取消的话,下一个 session/prompt 会一直
 *  排队在旧回合之后反复超时(opencode 卡死实测)。 */
export class AcpTimeoutError extends Error {
	constructor(method: string, timeoutMs: number) {
		super(`ACP request timed out after ${timeoutMs}ms: ${method}`);
		this.name = "AcpTimeoutError";
	}
}

/** handler 返回本哨兵时连接层不自动 respond（请求将由调用方经 respond() 异步应答）。 */
export const ACP_DEFER_RESPONSE: unique symbol = Symbol("ACP_DEFER_RESPONSE");

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

/** agent → client 请求的处理器注册；返回值作为 result，抛错按 JSON-RPC error 回给 agent。
 *  rpcId 供需要延迟应答的请求（如 session/request_permission 的异步审批）直接 respond。 */
export type AcpRequestHandler = (params: Record<string, unknown> | undefined, rpcId: AcpRpcId) => Promise<unknown> | unknown;

/**
 * 超过该长度的 NDJSON 行延后到 setImmediate 再 JSON.parse（与 PiRpcClient 同因：
 * 大响应不该堵住主进程事件循环）。数值对齐 PiRpcClient 便于统一心智。
 */
export const LARGE_ACP_LINE_PARSE_CHARS = 256 * 1024;

/** 单行缓冲硬上限：无 LF 的失控输出会让行缓冲无界增长（对齐 PiRpcClient）。 */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;

const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * ACP stdio transport：NDJSON 上的 JSON-RPC 2.0 双向连接。
 *
 * 与 PiRpcClient 的差异：JSON-RPC 标准信封（method/result/error 字段），
 * 且双向——agent 也会向 client 发请求（session/request_permission 等），
 * 这类请求经 handleRequest 注册的处理器应答。
 *
 * 行缓冲护栏与大行延迟解析沿用 PiRpcClient 的实测结论（见该类注释）。
 */
export class AcpConnection extends EventEmitter {
	private buffer = "";
	private nextRequestId = 1;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<number, PendingRequest>();
	private readonly requestHandlers = new Map<string, AcpRequestHandler>();
	private parseQueue: Promise<void> = Promise.resolve();
	/** 大帧在途时后续小帧也排队；否则 prompt 响应会超车，先结算再收到正文。 */
	private queuedLines = 0;
	private closed = false;
	private finishing = false;
	private closeReason: Error | null = null;

	constructor(
		private readonly stdin: NodeJS.WritableStream,
		stdout: NodeJS.ReadableStream,
	) {
		super();
		// 断管是连接终态，立即结算请求；不能让用户再等完整的 prompt 超时。
		this.stdin.on("error", (error) => this.close(error));
		stdout.on("data", (chunk) => this.consumeChunk(chunk));
		stdout.on("end", () => this.consumeEnd());
		stdout.on("error", (error) => this.close(error));
	}

	/** agent → client 请求分发注册。同名方法重复注册以后注册者为准（会话级覆盖）。 */
	handleRequest(method: string, handler: AcpRequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	handleRequestDisappear(method: string): void {
		this.requestHandlers.delete(method);
	}

	/** client → agent 请求；agent 返回 error 时 reject AcpRpcError。 */
	request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(this.closeReason ? new Error(`${this.closeReason.message} (ACP request not sent: ${method})`) : new Error(`ACP connection closed: ${method}`));
		}
		const id = this.nextRequestId++;
		const payload: AcpRpcRequest = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };

		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new AcpTimeoutError(method, timeoutMs));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});

		this.write(payload);
		return promise;
	}

	/** client → agent 通知（fire-and-forget）。 */
	notify(method: string, params?: Record<string, unknown>): void {
		if (this.closed) return;
		const payload: AcpRpcNotification = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
		this.write(payload);
	}

	/** agent → client 请求的直接应答通道（供连接层之外的审批应答使用）。 */
	respond(id: AcpRpcId, result: unknown): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", id, result } as Record<string, unknown>);
	}

	respondError(id: AcpRpcId, code: number, message: string): void {
		if (this.closed) return;
		this.write({ jsonrpc: "2.0", id, error: { code, message } } as Record<string, unknown>);
	}

	close(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.buffer = "";
		this.closeReason = error ?? null;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error("ACP connection closed before response"));
		}
		this.pending.clear();
		this.emit("closed", error ?? null);
	}

	/** 正常管道/进程结束先排空大帧队列；显式 stop 或传输失败仍用 close 立即取消。 */
	finish(error = new Error("ACP agent stdout ended")): void {
		if (this.closed || this.finishing) return;
		this.finishing = true;
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) {
			this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
			this.buffer = "";
		}
		if (this.queuedLines === 0) this.close(error);
		else void this.parseQueue.then(() => this.close(error));
	}

	isClosed(): boolean {
		return this.closed;
	}

	private write(payload: Record<string, unknown>): void {
		if (this.closed) return;
		this.emit("log", { direction: "send", data: payload });
		try {
			this.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			this.close(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private consumeChunk(chunk: Buffer | string): void {
		if (this.closed || this.finishing) return;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		// 一个 chunk 可以含很多合法行；先分帧，再限制剩余未完成行，不能整批丢弃。
		this.drainLines();
		const bytes = Buffer.byteLength(this.buffer, "utf8");
		if (!this.closed && bytes > MAX_ACP_LINE_BYTES) this.lineOverflow(bytes);
	}

	private consumeEnd(): void {
		this.finish();
	}

	private lineOverflow(bytes: number): void {
		const error = new Error(`ACP line buffer overflow: ${bytes} bytes exceeds ${MAX_ACP_LINE_BYTES} byte limit`);
		this.emit("protocol-error", error.message);
		this.close(error);
	}

	private drainLines(): void {
		while (!this.closed) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			let line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		if (this.closed) return;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > MAX_ACP_LINE_BYTES) {
			this.lineOverflow(bytes);
			return;
		}
		if (!line.trim()) return;
		const large = line.length > LARGE_ACP_LINE_PARSE_CHARS;
		if (!large && this.queuedLines === 0) {
			this.dispatchLine(line);
			return;
		}
		this.queuedLines += 1;
		this.parseQueue = this.parseQueue
			.then(async () => {
				if (large) await new Promise<void>((resolve) => setImmediate(resolve));
				// stop()/进程失败显式 close 后，不再投递排队中的迟到通知。
				if (!this.closed) this.dispatchLine(line);
			})
			.catch((error: unknown) => this.close(error instanceof Error ? error : new Error(String(error))))
			.finally(() => {
				this.queuedLines -= 1;
			});
	}

	private dispatchLine(line: string): void {
		let message: AcpJsonRpcMessage;
		try {
			message = JSON.parse(line) as AcpJsonRpcMessage;
		} catch {
			// stdout 混入非 JSON 输出（CLI banner、调试日志）：保留原文上抛，由上层决定是否致命。
			this.emit("protocol-error", line);
			return;
		}
		this.emit("log", { direction: "recv", data: message });

		if (!message || typeof message !== "object" || !("jsonrpc" in message)) return;

		// 响应（有 id 无 method）：结算 pending。
		if (!("method" in message)) {
			const id = typeof (message as { id?: unknown }).id === "number" ? ((message as { id: number }).id as number) : null;
			if (id === null) return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			const error = (message as { error?: { code: number; message: string; data?: unknown } }).error;
			if (error) pending.reject(new AcpRpcError(error.message, error.code, error.data));
			else pending.resolve((message as { result?: unknown }).result);
			return;
		}

		// agent → client 请求（有 id 有 method）：分发给注册的处理器。
		if ("id" in message) {
			if (typeof message.id !== "number" && typeof message.id !== "string") return;
			void this.dispatchAgentRequest(message as AcpIncomingRequest);
			return;
		}

		// 通知（无 id）。
		this.emit("notification", message as AcpRpcNotification);
	}

	private async dispatchAgentRequest(message: AcpIncomingRequest): Promise<void> {
		const handler = this.requestHandlers.get(message.method);
		if (!handler) {
			// 未注册的方法按 JSON-RPC 约定回 method not found，agent 能据此降级。
			this.respondError(message.id, -32601, `Method not found: ${message.method}`);
			return;
		}
		try {
			const result = await handler(message.params, message.id);
			// 异步应答（审批等）：handler 显式声明延迟，连接层不代答。
			if (result === ACP_DEFER_RESPONSE) return;
			this.respond(message.id, result ?? {});
		} catch (error) {
			const message_ = error instanceof Error ? error.message : String(error);
			this.respondError(message.id, JSON_RPC_INTERNAL_ERROR, message_);
		}
	}
}
