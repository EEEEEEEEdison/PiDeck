/**
 * 「按模型/供应商走代理」名单是否已启用（纯函数，主进程策略与渲染层设置页共用）。
 *
 * 为什么放在 shared：名单一旦非空，pi 代理策略就完全由名单决定（名单内强制走代理、
 * 名单外强制直连），主开关「启用 Pi agent 代理」不再参与任何决策——见
 * src/main/sessions/sessionProxyPolicy.ts 的 resolveListedProxyMode / resolveDshHostProxyMode。
 * 设置页据此把主开关置灰并给出提示；两处若各写一份判断，策略调整时提示会静默失真。
 *
 * 供应商名单（piProxyProviders）是旧版字段，UI 入口已移除，但升级前已配置的数据仍需
 * 参与判断（与 resolveListedProxyMode 的兼容读取一致）。
 */
export function hasPiProxyListFilter(piProxyProviders: ReadonlyArray<string> | undefined, piProxyModels: ReadonlyArray<string> | undefined): boolean {
	return (piProxyProviders?.length ?? 0) > 0 || (piProxyModels?.length ?? 0) > 0;
}
