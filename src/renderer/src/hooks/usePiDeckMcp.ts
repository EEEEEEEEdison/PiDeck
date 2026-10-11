/** Desktop MCP consent editor; lifecycle guards keep late responses out of unmounted panels. */
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { PiDeckMcpState } from "../../../shared/types/piDeckMcp";
import type { McpConfigFile } from "../../../shared/types/mcp";

export function usePiDeckMcp() {
	const [state, setState] = useState<PiDeckMcpState | null>(null);
	const [projectIds, setProjectIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);
	const pending = useRef(false);
	const refresh = useCallback(async () => {
		if (pending.current) return;
		pending.current = true;
		const epoch = generation.current;
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.piDeckMcp.getState();
			if (generation.current !== epoch) return;
			if (!result.ok) {
				setError(result.code);
				return;
			}
			setState(result.value);
			setProjectIds(result.value.projectIds);
			setError(result.value.error ?? null);
		} catch {
			if (generation.current === epoch) setError("operation-failed");
		} finally {
			if (generation.current === epoch) {
				pending.current = false;
				setBusy(false);
			}
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			generation.current++;
			pending.current = false;
		};
	}, [refresh]);

	const apply = useCallback(
		async (enabled: boolean) => {
			if (pending.current) return;
			pending.current = true;
			const epoch = generation.current;
			setBusy(true);
			setError(null);
			try {
				const result = await desktopApi.piDeckMcp.setAccess({ enabled, projectIds: enabled ? projectIds : [] });
				if (generation.current !== epoch) return;
				if (result.ok) {
					setState(result.value);
					setProjectIds(result.value.projectIds);
				} else {
					setError(result.code);
					// Failure can have stopped the listener: never keep displaying stale running state.
					const latest = await desktopApi.piDeckMcp.getState();
					if (generation.current === epoch && latest.ok) setState(latest.value);
				}
			} catch {
				if (generation.current === epoch) setError("operation-failed");
			} finally {
				if (generation.current === epoch) {
					pending.current = false;
					setBusy(false);
				}
			}
		},
		[projectIds],
	);

	/** Sensitive connection config lives only for this operation, not in component/atom state. */
	const withConnection = useCallback(async (action: (config: McpConfigFile) => Promise<boolean>) => {
		if (pending.current) return false;
		pending.current = true;
		const epoch = generation.current;
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.piDeckMcp.connection();
			if (generation.current !== epoch) return false;
			if (!result.ok) {
				setError(result.code);
				return false;
			}
			const ok = await action(result.value);
			if (!ok && generation.current === epoch) setError("operation-failed");
			return ok && generation.current === epoch;
		} catch {
			if (generation.current === epoch) setError("operation-failed");
			return false;
		} finally {
			if (generation.current === epoch) {
				pending.current = false;
				setBusy(false);
			}
		}
	}, []);
	return { state, projectIds, setProjectIds, busy, error, refresh, apply, withConnection };
}
