/**
 * WeChatSection — 微信 iLink（ClawBot）桥接设置区。
 *
 * 与飞书区最大的差异：微信没有 App ID/Secret 表单，登录是「扫码 + 手机确认」，
 * 所以这里必须能渲染二维码。二维码由渲染层生成（useQrDataUrl），主进程只给
 * 待编码字符串——主进程不引图像栈，也避免二维码内容经过 IPC 二进制通道。
 *
 * 微信侧是 1:1 单账号：没有多 Bot、没有群聊、不能主动推送，界面刻意不提供
 * 对应开关（见 shared/types/wechat.ts 的说明），免得用户以为只是没做。
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { ConfirmDialog } from "../../app/AppParts";
import type { WeChatBridgeStatus, WeChatChatBinding, WeChatIpcResult, WeChatLoginState, WeChatSettings, WeChatSettingsSnapshot } from "../../../../../shared/types";
import { formatI18nDateTime, t, type TranslationKey } from "../../../i18n";
import { useQrDataUrl } from "./useQrDataUrl";

/**
 * preload 的微信命名空间在本组件里按可选字段声明：预览模式（previewApi）下
 * 这些方法存在但一律返回不支持，缺失时界面显示「不可用」而不是崩。
 */
type WeChatApiRaw = {
	snapshot?: () => Promise<WeChatIpcResult<WeChatSettingsSnapshot>>;
	setEnabled?: (enabled: boolean) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	updateSettings?: (patch: { defaultWorkspaceId?: string; defaultModelId?: string }) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	renameAccount?: (displayName: string) => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	logout?: () => Promise<WeChatIpcResult<{ settings: WeChatSettings }>>;
	beginLogin?: () => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	cancelLogin?: () => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	submitVerifyCode?: (code: string) => Promise<WeChatIpcResult<{ state: WeChatLoginState }>>;
	getLoginState?: () => Promise<WeChatLoginState>;
	unbindChat?: (chatId: string) => Promise<WeChatIpcResult<{ removed: boolean; bindings: WeChatChatBinding[] }>>;
	onStatus?: (cb: (status: WeChatBridgeStatus) => void) => () => void;
	onLoginState?: (cb: (state: WeChatLoginState) => void) => () => void;
	onBindingsChanged?: (cb: (bindings: WeChatChatBinding[]) => void) => () => void;
};

/** 登录阶段 → 文案 key。集中映射避免 JSX 里堆 switch。 */
const PHASE_LABEL: Record<WeChatLoginState["phase"], TranslationKey> = {
	idle: "config.wechat.phase.idle",
	waiting: "config.wechat.phase.waiting",
	scanned: "config.wechat.phase.scanned",
	"need-verify-code": "config.wechat.phase.needVerifyCode",
	confirmed: "config.wechat.phase.confirmed",
	expired: "config.wechat.phase.expired",
	error: "config.wechat.phase.error",
};

/**
 * 状态机只给错误码（流程代码里不写用户可见文案），文案由渲染层映射。
 * 映射不到的码回退到通用的「错误」标签，不把英文码摊到界面上。
 */
const LOGIN_ERROR_LABEL: Record<string, TranslationKey> = {
	verify_code_blocked: "config.wechat.loginError.verifyCodeBlocked",
	"confirmed without credentials": "config.wechat.loginError.noCredentials",
};

export function WeChatSection() {
	const [snapshot, setSnapshot] = useState<WeChatSettingsSnapshot | null>(null);
	const [loginState, setLoginState] = useState<WeChatLoginState>({ phase: "idle" });
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [verifyCode, setVerifyCode] = useState("");
	const [confirmLogout, setConfirmLogout] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState("");

	const api = (window as unknown as { piDesktop?: { wechat?: WeChatApiRaw } }).piDesktop?.wechat;
	const qrDataUrl = useQrDataUrl(loginState.qrcodeContent ?? "");

	const loadSnapshot = useCallback(async () => {
		if (!api?.snapshot) {
			setLoading(false);
			return;
		}
		try {
			const result = await api.snapshot();
			if (result.ok) setSnapshot(result);
			else setError(result.message);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [api]);

	useEffect(() => {
		void loadSnapshot();
	}, [loadSnapshot]);

	// 订阅三个推送：状态、登录阶段、绑定变化。组件卸载必须退订（preload 返回 unsubscribe）。
	useEffect(() => {
		if (!api) return;
		const offStatus = api.onStatus?.((status) => {
			setSnapshot((prev) => (prev ? { ...prev, status } : prev));
		});
		const offLogin = api.onLoginState?.((state) => {
			setLoginState(state);
			// 扫码确认后主进程已把账号落盘并把开关置为启用，快照不重拉会让界面继续显示
			// 「尚未登录 + 开关关闭」，用户会以为扫码没生效。
			if (state.phase === "confirmed") void loadSnapshot();
		});
		const offBindings = api.onBindingsChanged?.((bindings) => {
			setSnapshot((prev) => (prev ? { ...prev, bindings } : prev));
		});
		return () => {
			offStatus?.();
			offLogin?.();
			offBindings?.();
		};
	}, [api, loadSnapshot]);

	// 初始登录阶段也要拉一次：事件只覆盖「变化」，刷新页面后没人会再推。
	useEffect(() => {
		if (!api?.getLoginState) return;
		void api.getLoginState().then(setLoginState);
	}, [api]);

	const runAction = useCallback(async (action: () => Promise<WeChatIpcResult<Record<string, unknown>>>) => {
		setBusy(true);
		setError(null);
		try {
			const result = await action();
			if (!result.ok) setError(result.message);
			return result;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return { ok: false as const, message: String(e) };
		} finally {
			setBusy(false);
		}
	}, []);

	const handleToggleEnabled = useCallback(
		async (enabled: boolean) => {
			if (!api?.setEnabled) return;
			await runAction(() => api.setEnabled?.(enabled) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	const handleBeginLogin = useCallback(async () => {
		if (!api?.beginLogin) return;
		setVerifyCode("");
		const result = await runAction(() => api.beginLogin?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok && "state" in result) setLoginState(result.state as WeChatLoginState);
	}, [api, runAction]);

	const handleCancelLogin = useCallback(async () => {
		if (!api?.cancelLogin) return;
		const result = await runAction(() => api.cancelLogin?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok) setLoginState({ phase: "idle" });
		await loadSnapshot();
	}, [api, runAction, loadSnapshot]);

	const handleSubmitVerifyCode = useCallback(async () => {
		const code = verifyCode.trim();
		if (!api?.submitVerifyCode || !code) return;
		const result = await runAction(() => api.submitVerifyCode?.(code) as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok && "state" in result) {
			setLoginState(result.state as WeChatLoginState);
			setVerifyCode("");
		}
	}, [api, runAction, verifyCode]);

	const handleLogout = useCallback(async () => {
		setConfirmLogout(false);
		if (!api?.logout) return;
		await runAction(() => api.logout?.() as Promise<WeChatIpcResult<Record<string, unknown>>>);
		setLoginState({ phase: "idle" });
		await loadSnapshot();
	}, [api, runAction, loadSnapshot]);

	const handleUnbind = useCallback(
		async (chatId: string) => {
			if (!api?.unbindChat) return;
			const result = await runAction(() => api.unbindChat?.(chatId) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok && "bindings" in result) {
				const bindings = result.bindings as WeChatChatBinding[];
				setSnapshot((prev) => (prev ? { ...prev, bindings } : prev));
			}
		},
		[api, runAction],
	);

	const handleRenameSave = useCallback(async () => {
		const name = nameDraft.trim();
		setRenaming(false);
		if (!api?.renameAccount || !name) return;
		const result = await runAction(() => api.renameAccount?.(name) as Promise<WeChatIpcResult<Record<string, unknown>>>);
		if (result.ok) await loadSnapshot();
	}, [api, nameDraft, runAction, loadSnapshot]);

	const handleWorkspaceChange = useCallback(
		async (workspaceId: string) => {
			if (!api?.updateSettings) return;
			const result = await runAction(() => api.updateSettings?.({ defaultWorkspaceId: workspaceId }) as Promise<WeChatIpcResult<Record<string, unknown>>>);
			if (result.ok) await loadSnapshot();
		},
		[api, runAction, loadSnapshot],
	);

	if (!api?.snapshot) {
		return <p className="text-muted-foreground text-sm">{t("config.wechat.unavailable")}</p>;
	}

	if (loading) {
		return (
			<div className="text-muted-foreground flex items-center gap-2 text-sm">
				<Loader2 className="h-4 w-4 animate-spin" />
				{t("config.wechat.loading")}
			</div>
		);
	}

	const settings = snapshot?.settings;
	const status = snapshot?.status;
	const account = settings?.account ?? null;
	const bindings = snapshot?.bindings ?? [];
	const projects = snapshot?.projects ?? [];
	const loginInProgress = loginState.phase !== "idle" && loginState.phase !== "confirmed";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-foreground text-sm font-medium">{t("config.wechat.title")}</span>
					<span className="text-muted-foreground text-xs">{t("config.wechat.description")}</span>
				</div>
				<Switch checked={settings?.enabled ?? false} disabled={busy} onCheckedChange={(checked) => void handleToggleEnabled(checked)} />
			</div>

			{error ? <p className="text-destructive text-xs">{error}</p> : null}

			<div className="border-border bg-card flex flex-col gap-3 rounded-md border p-3">
				<div className="flex items-center justify-between gap-2">
					<span className="text-foreground text-xs font-medium">{t("config.wechat.account")}</span>
					<span className="text-muted-foreground text-xs">{t(`config.wechat.status.${status?.status ?? "disconnected"}`)}</span>
				</div>

				{account ? (
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							{renaming ? (
								<>
									<Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-7 text-xs" />
									<Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleRenameSave()}>
										{t("common.save")}
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
										{t("common.cancel")}
									</Button>
								</>
							) : (
								<>
									<span className="text-foreground text-sm">{account.displayName}</span>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setNameDraft(account.displayName);
											setRenaming(true);
										}}
									>
										{t("common.rename")}
									</Button>
								</>
							)}
						</div>
						<span className="text-muted-foreground text-xs">{t("config.wechat.loggedInHint", { time: formatI18nDateTime(account.loggedInAt) })}</span>
						{status?.errorMessage === "login-required" ? <span className="text-destructive text-xs">{t("config.wechat.needRelogin")}</span> : null}
						{status?.errorMessage === "credential-unavailable" ? <span className="text-destructive text-xs">{t("config.wechat.credentialUnavailable")}</span> : null}
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleBeginLogin()}>
								<RefreshCw className="mr-1 h-3.5 w-3.5" />
								{t("config.wechat.rescan")}
							</Button>
							<Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmLogout(true)}>
								{t("config.wechat.logout")}
							</Button>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<span className="text-muted-foreground text-xs">{t("config.wechat.notLoggedIn")}</span>
						<p className="text-muted-foreground text-xs">{t("config.wechat.grayHint")}</p>
						{!loginInProgress ? (
							<Button size="sm" disabled={busy} onClick={() => void handleBeginLogin()}>
								{t("config.wechat.scanLogin")}
							</Button>
						) : null}
					</div>
				)}

				{loginInProgress ? (
					<div className="border-border flex flex-col items-center gap-2 border-t pt-3">
						<span className="text-foreground text-xs">{t(PHASE_LABEL[loginState.phase])}</span>
						{qrDataUrl ? <img src={qrDataUrl} alt={t("config.wechat.qrAlt")} className="h-40 w-40 rounded bg-white p-1" /> : null}
						{loginState.error ? <span className="text-muted-foreground text-xs">{t(LOGIN_ERROR_LABEL[loginState.error] ?? "config.wechat.phase.error")}</span> : null}
						{loginState.phase === "need-verify-code" ? (
							<div className="flex w-full items-center gap-2">
								<Input value={verifyCode} onChange={(event) => setVerifyCode(event.target.value)} placeholder={t("config.wechat.verifyCodePlaceholder")} className="h-7 text-xs" />
								<Button size="sm" disabled={busy || !verifyCode.trim()} onClick={() => void handleSubmitVerifyCode()}>
									{t("common.submit")}
								</Button>
							</div>
						) : null}
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleCancelLogin()}>
							{t("common.cancel")}
						</Button>
					</div>
				) : null}
			</div>

			{account && projects.length > 0 ? (
				<div className="flex flex-col gap-1">
					<Label className="text-xs">{t("config.wechat.workspace")}</Label>
					<Select value={settings?.defaultWorkspaceId ?? ""} onValueChange={(value) => void handleWorkspaceChange(value)}>
						<SelectTrigger className="w-60">
							<SelectValue placeholder={t("config.wechat.workspacePlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							{projects.map((project) => (
								<SelectItem key={project.id} value={project.id}>
									{project.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<span className="text-muted-foreground text-xs">{t("config.wechat.workspaceHint")}</span>
				</div>
			) : null}

			<div className="flex flex-col gap-2">
				<span className="text-foreground text-xs font-medium">{t("config.wechat.bindings", { count: bindings.length })}</span>
				{bindings.length === 0 ? (
					<span className="text-muted-foreground text-xs">{t("config.wechat.noBindings")}</span>
				) : (
					bindings.map((binding) => (
						<div key={binding.chatId} className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2">
							<div className="flex flex-col">
								<span className="text-foreground text-xs">{binding.chatId}</span>
								<span className="text-muted-foreground text-xs">{binding.workspaceId}</span>
							</div>
							<Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleUnbind(binding.chatId)}>
								{t("config.wechat.unbind")}
							</Button>
						</div>
					))
				)}
			</div>

			<p className="text-muted-foreground text-xs">{t("config.wechat.p2pHint")}</p>

			{confirmLogout ? <ConfirmDialog title={t("config.wechat.logout")} message={t("config.wechat.logoutMessage")} onCancel={() => setConfirmLogout(false)} onConfirm={() => void handleLogout()} /> : null}
		</div>
	);
}
