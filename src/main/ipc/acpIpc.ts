/**
 * ACP 域 IPC:工具登记表的读/存/校验 + 预设工具生命周期(检测/安装/卸载)。
 *
 * 只做输入校验与适配(硬规则):业务在 SettingsStore(acpTools 字段)、
 * acpToolConfig(消毒/校验纯函数)与 acpToolLifecycle(进程编排);
 * AcpAgentManager 由 index.ts 装配,这里不触碰(工具表变化不需要通知运行中的
 * agent 进程——配置在 spawn 时快照)。
 *
 * 生命周期安全边界:presetId 只认内置预设枚举,安装/卸载命令全部来自
 * ACP_TOOL_PRESETS 内置表(不接受用户命令串)——这不是任意命令执行入口;
 * manual 安装形态(claude/cursor 官网脚本)在 IPC 层直接拒绝并给出引导文案 key。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AcpSessionConfigOption, AcpToolConfig } from "../../shared/types/acp";
import { sanitizeAcpTools, validateAcpTool } from "../acp/acpToolConfig";
import { detectAcpPreset, findPresetById, runNpmGlobalAction, type AcpToolLifecycleDeps } from "../acp/acpToolLifecycle";
import type { AcpLifecycleEvent, AcpToolStatus } from "../../shared/types/acp";
import type { SettingsStore } from "../settings/SettingsStore";

export function registerAcpIpc(deps: {
	settingsStore: SettingsStore;
	getLifecycleDeps?: () => AcpToolLifecycleDeps;
	getSessionManager?: () => { getSessionConfigOptions(agentId: string): AcpSessionConfigOption[] | undefined; applyConfigOption(agentId: string, optionId: string, value: string | boolean): Promise<AcpSessionConfigOption[]> };
	/** 开发渠道判定（isDevChannelBuild）：ACP 仅供开发构建，stable 渲染层已隐藏全部入口，这里是边界防御。 */
	isDevChannel: () => boolean;
}): void {
	const { settingsStore } = deps;
	// stable 渄属的直接拒绝（渲染层入口已隐藏，正常到不了这里）：
	// 工具表读退空数组（App 挂载无条件初拉，拒绝会制造无意义噪音），写/校验/生命周期直接拒绝。
	const devOnly = (action: string): void => {
		if (!deps.isDevChannel()) throw new Error(`ACP ${action} is only available in the PiDeck dev channel`);
	};

	ipcMain.handle(ipcChannels.acpToolsList, () => (deps.isDevChannel() ? (settingsStore.get().acpTools ?? []) : []));

	ipcMain.handle(ipcChannels.acpToolsSave, (_event, tools: unknown): AcpToolConfig[] => {
		devOnly("tool management");
		// 整表替换语义(渲染层持有完整列表):消毒在 SettingsStore.update 再做一次,
		// 这里先粗校验形状,让非数组入参在 IPC 边界直接报错而不是静默清表。
		if (!Array.isArray(tools)) throw new Error("acp:tools-save expects an array of tools");
		const sanitized = sanitizeAcpTools(tools);
		settingsStore.update({ acpTools: sanitized });
		return settingsStore.get().acpTools ?? [];
	});

	ipcMain.handle(ipcChannels.acpToolValidate, (_event, input: unknown): ReturnType<typeof validateAcpTool> => {
		devOnly("tool management");
		if (!input || typeof input !== "object") return { ok: false, reasonKey: "acp.toolNameRequired" };
		const record = input as Record<string, unknown>;
		return validateAcpTool(
			{
				id: typeof record.id === "string" ? record.id : undefined,
				name: record.name,
				command: record.command,
				args: record.args,
				env: record.env,
			},
			settingsStore.get().acpTools ?? [],
		);
	});

	// ── 预设工具生命周期(检测只读;安装/卸载有全局 npm 副作用,由渲染层确认弹窗把关) ──
	// 惰性取依赖:注册时 piLocator 可能尚未创建(index.ts 里注册在前、实例化在后)。
	const getLifecycleDeps = (): AcpToolLifecycleDeps => {
		const resolved = deps.getLifecycleDeps?.();
		if (!resolved) throw new Error("acp: lifecycle not available");
		return resolved;
	};

	const requirePreset = (input: unknown) => {
		if (typeof input !== "string") throw new Error("acp: expects a presetId string");
		const preset = findPresetById(input);
		if (!preset) throw new Error(`acp: unknown presetId: ${input.slice(0, 40)}`);
		return preset;
	};

	ipcMain.handle(ipcChannels.acpToolDetect, async (_event, presetId: unknown): Promise<AcpToolStatus> => {
		devOnly("tool management");
		const preset = requirePreset(presetId);
		return detectAcpPreset(getLifecycleDeps(), preset);
	});

	const runAction = async (presetId: unknown, action: "install" | "uninstall", sender: Electron.WebContents): Promise<{ ok: boolean; output: string }> => {
		devOnly("tool management");
		const preset = requirePreset(presetId);
		const lifecycleDeps = getLifecycleDeps();
		// manual 形态(claude/cursor 官网脚本)不经 npm:拒绝执行,渲染层拿 error 引导用户去官网。
		if (preset.install?.kind !== "npm") throw new Error("acp: preset is not npm-installable");
		const send = (event: AcpLifecycleEvent) => {
			// 设置页可能中途关闭:destroyed 后 send 会抛,吞掉即可(结果还有 invoke 返回兜底)。
			try {
				if (!sender.isDestroyed()) sender.send(ipcChannels.acpLifecycleEvent, event);
			} catch {
				/* webContents 已销毁,进度丢弃 */
			}
		};
		send({ presetId: preset.id, phase: "line", line: `$ npm ${action === "install" ? "install" : "uninstall"} -g ${preset.install.package}` });
		const result = await runNpmGlobalAction(lifecycleDeps, preset, action, (line) => send({ presetId: preset.id, phase: "line", line }));
		send({ presetId: preset.id, phase: "done", ok: result.ok, output: result.output.slice(-4000) });
		return result;
	};

	ipcMain.handle(ipcChannels.acpToolInstall, (event, presetId: unknown) => runAction(presetId, "install", event.sender));
	ipcMain.handle(ipcChannels.acpToolUninstall, (event, presetId: unknown) => runAction(presetId, "uninstall", event.sender));

	// ── 会话级配置(configOptions 规范路径):查询/下发,变更经 acpSessionConfigChanged 推送 ──
	// manager 惰性取:开关关闭时未实例化,直接报未启用而不是 undefined 崩溃。
	const requireSessionManager = () => {
		const manager = deps.getSessionManager?.();
		if (!manager) throw new Error("acp: session config not enabled");
		return manager;
	};

	ipcMain.handle(ipcChannels.acpSessionConfigGet, (_event, agentId: unknown): AcpSessionConfigOption[] | null => {
		if (typeof agentId !== "string" || !agentId.trim()) throw new Error("acp: expects an agentId string");
		return requireSessionManager().getSessionConfigOptions(agentId) ?? null;
	});

	ipcMain.handle(ipcChannels.acpSessionConfigSet, (_event, input: unknown): Promise<AcpSessionConfigOption[]> => {
		// 入参不可信:agentId/optionId 只收非空字符串;value 限 string(≤256)/boolean,
		// 枚举合法性由 agent 侧裁决(客户端不维护模型清单,避免手写表漂移)。
		if (!input || typeof input !== "object") throw new Error("acp: expects a config payload");
		const record = input as Record<string, unknown>;
		if (typeof record.agentId !== "string" || !record.agentId.trim()) throw new Error("acp: expects an agentId string");
		if (typeof record.optionId !== "string" || !record.optionId.trim()) throw new Error("acp: expects an optionId string");
		const value = record.value;
		if (typeof value !== "boolean" && (typeof value !== "string" || value.length > 256 || /[\x00-\x1f]/.test(value))) throw new Error("acp: invalid config value");
		return requireSessionManager().applyConfigOption(record.agentId, record.optionId, value);
	});
}
