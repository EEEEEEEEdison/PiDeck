/** Private MCP host consent/credential file, independent of pi's client configuration. */
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const piDeckMcpAccessSchema = z
	.object({
		enabled: z.boolean(),
		projectIds: z
			.array(
				z
					.string()
					.min(1)
					.max(200)
					.regex(/^[^\u0000-\u001f]+$/),
			)
			.max(1000),
	})
	.strict();
const storedSchema = piDeckMcpAccessSchema
	.extend({
		version: z.literal(1),
		port: z.number().int().min(0).max(65535),
		token: z.string().regex(/^(?:[a-f0-9]{64})?$/),
	})
	.strict();
export type PiDeckMcpConfig = z.infer<typeof storedSchema>;
export const emptyPiDeckMcpConfig = (): PiDeckMcpConfig => ({ version: 1, enabled: false, projectIds: [], port: 0, token: "" });

/** Corrupt/oversized files fail closed; absence alone means first-run defaults. */
export async function readPiDeckMcpConfig(path: string): Promise<PiDeckMcpConfig> {
	let handle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyPiDeckMcpConfig();
		throw new Error("config-read-failed");
	}
	try {
		const buffer = Buffer.alloc(256 * 1024 + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 256 * 1024) throw new Error("config-read-failed");
		const value = storedSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
		if (value.enabled && (!value.token || !value.port || !value.projectIds.length)) throw new Error("config-read-failed");
		return value;
	} catch {
		throw new Error("config-read-failed");
	} finally {
		await handle.close();
	}
}

/** Owner-only atomic replacement. Secrets never enter settings snapshots or logs. */
export async function writePiDeckMcpConfig(path: string, config: PiDeckMcpConfig): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch {
		throw new Error("config-write-failed");
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}
