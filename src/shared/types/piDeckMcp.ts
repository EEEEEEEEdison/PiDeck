/** PiDeck's optional, local-only MCP host. Management is desktop-only, never an MCP tool. */
import type { McpConfigFile } from "./mcp";

export type PiDeckMcpAccess = { enabled: boolean; projectIds: string[] };
export type PiDeckMcpProject = { id: string; name: string };
export type PiDeckMcpState = PiDeckMcpAccess & {
	running: boolean;
	projects: PiDeckMcpProject[];
	endpoint?: string;
	/** Stable, non-sensitive error code; credentials are only returned by connection(). */
	error?: string;
};
export type PiDeckMcpResult<T> = { ok: true; value: T } | { ok: false; code: string };
export type PiDeckMcpDesktopApi = {
	getState: () => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	setAccess: (input: PiDeckMcpAccess) => Promise<PiDeckMcpResult<PiDeckMcpState>>;
	connection: () => Promise<PiDeckMcpResult<McpConfigFile>>;
};
