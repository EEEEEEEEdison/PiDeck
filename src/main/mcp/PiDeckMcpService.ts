/** Owns consent, credentials and listener lifecycle; never activates or commands a pi runtime. */
import { randomBytes } from "node:crypto";
import type { PiDeckMcpAccess, PiDeckMcpProject, PiDeckMcpState } from "../../shared/types/piDeckMcp";
import type { McpConfigFile } from "../../shared/types/mcp";
import { emptyPiDeckMcpConfig, piDeckMcpAccessSchema, readPiDeckMcpConfig, writePiDeckMcpConfig, type PiDeckMcpConfig } from "../config/piDeckMcpConfig";
import type { HostPluginSessions } from "../plugins/HostPluginSessions";
import { createPiDeckMcpServer } from "./piDeckMcpTools";
import { PiDeckMcpHttpServer } from "./PiDeckMcpHttpServer";

export class PiDeckMcpService {
	private config: PiDeckMcpConfig = emptyPiDeckMcpConfig();
	private listener?: PiDeckMcpHttpServer;
	private endpoint?: string;
	private error?: string;
	private epoch = 0;
	private disposed = false;
	private pending: Promise<unknown>;
	constructor(
		private readonly deps: {
			configPath: string;
			projects: () => PiDeckMcpProject[];
			sessions: Pick<HostPluginSessions, "list" | "get" | "search" | "entries">;
			warn: (code: string) => void;
		},
	) {
		// Startup failures are isolated from the desktop and visible on the management page.
		this.pending = this.initialize();
	}

	private async initialize(): Promise<void> {
		const epoch = this.epoch;
		try {
			this.config = await readPiDeckMcpConfig(this.deps.configPath);
			if (this.config.enabled && !this.disposed && epoch === this.epoch) await this.start(this.config, epoch);
		} catch (error) {
			// Preserve saved consent on bind failure so the UI can still revoke it on disk.
			this.error = error instanceof Error && error.message === "config-read-failed" ? "config-read-failed" : "listen-failed";
			this.deps.warn(this.error);
		}
	}

	async getState(): Promise<PiDeckMcpState> {
		await this.pending;
		return this.snapshot();
	}
	private snapshot(): PiDeckMcpState {
		return { enabled: this.config.enabled, projectIds: [...this.config.projectIds], running: Boolean(this.endpoint), endpoint: this.endpoint, projects: this.deps.projects(), error: this.error };
	}

	/** Serialize writes; invalidate prior requests immediately, not after disk IO completes. */
	setAccess(input: PiDeckMcpAccess): Promise<PiDeckMcpState> {
		const access = piDeckMcpAccessSchema.parse(input);
		if (access.enabled && !access.projectIds.length) return Promise.reject(new Error("project-required"));
		if (access.projectIds.some((id) => !this.deps.projects().some((p) => p.id === id))) return Promise.reject(new Error("project-not-authorized"));
		const epoch = ++this.epoch;
		const operation = this.pending.then(async () => {
			if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
			// Retain saved consent until the replacement is durable; a failed revoke must
			// remain retryable in the UI. The epoch/endpoint already deny live access.
			this.endpoint = undefined;
			await this.stopListener();
			this.error = undefined;
			const next: PiDeckMcpConfig = { ...this.config, ...access, projectIds: [...new Set(access.projectIds)], token: access.enabled ? randomBytes(32).toString("hex") : "" };
			try {
				if (next.enabled) await this.start(next, epoch);
				if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
				await writePiDeckMcpConfig(this.deps.configPath, next);
				if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
				this.config = next;
				return this.snapshot();
			} catch (error) {
				this.endpoint = undefined;
				await this.stopListener();
				this.error = error instanceof Error && ["access-revoked", "config-write-failed"].includes(error.message) ? error.message : "listen-failed";
				this.deps.warn(this.error);
				throw new Error(this.error);
			}
		});
		this.pending = operation.catch(() => undefined);
		return operation;
	}

	/** Detach the owned instance before awaiting so TS and concurrent shutdown agree on ownership. */
	private async stopListener(): Promise<void> {
		const listener = this.listener;
		this.listener = undefined;
		await listener?.stop();
	}

	private async start(config: PiDeckMcpConfig, epoch: number): Promise<void> {
		const authorize = (projectId?: string) => {
			if (this.disposed || epoch !== this.epoch || !this.config.enabled || !this.endpoint) throw new Error("access-revoked");
			if (projectId && (!this.config.projectIds.includes(projectId) || !this.deps.projects().some((p) => p.id === projectId))) throw new Error("project-not-authorized");
		};
		const listener = new PiDeckMcpHttpServer(
			config.token,
			() =>
				createPiDeckMcpServer({
					sessions: this.deps.sessions,
					projects: () => this.deps.projects().filter((p) => this.config.projectIds.includes(p.id)),
					authorize,
				}),
			this.deps.warn,
		);
		this.listener = listener;
		try {
			config.port = await listener.start(config.port);
			if (this.disposed || epoch !== this.epoch) throw new Error("access-revoked");
			this.endpoint = `http://127.0.0.1:${config.port}/mcp`;
		} catch (error) {
			await listener.stop();
			throw error;
		}
	}

	/** Export is explicit, sensitive and disabled by default; never overwrites a user's mcp.json. */
	async connection(): Promise<McpConfigFile> {
		await this.pending;
		if (!this.config.enabled || !this.endpoint || this.disposed) throw new Error("service-disabled");
		return { mcpServers: { pideck: { url: this.endpoint, headers: { Authorization: `Bearer ${this.config.token}` }, enabled: false, exposure: "codemode", description: "Read-only access to explicitly authorized PiDeck projects and saved sessions." } } };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.epoch++;
		this.endpoint = undefined;
		await this.stopListener();
		await this.pending;
		await this.stopListener();
	}
}
