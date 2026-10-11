import { join, relative, sep } from "node:path";
import type { PiExtensionSummary } from "../../shared/types";
import { isBuiltInExtensionName } from "./builtInExtensions";
import { discoverExtensionEntries } from "./extensionDiscovery";

/** pi list 输出里被过滤扩展的标记。迁出后由 ExtensionManager 再导出，既有导入点不受影响。 */
export const FILTERED_SUFFIX = " (filtered)";

/**
 * 扫描 ~/.pi/agent/extensions/ 目录，发现未被 pi list 列出的本地扩展。
 * 发现规则与 pi 0.85 runtime resolver 共用：直接 .ts/.js、目录 index.ts/index.js，
 * 以及 package.json 的 pi.extensions 声明；同一目录声明多个入口仍只显示一行。
 */
export async function scanLocalExtensions(extensionsDir: string): Promise<PiExtensionSummary[]> {
	const roots = new Map<string, string>();
	for (const entryPath of discoverExtensionEntries(extensionsDir)) {
		const relativePath = relative(extensionsDir, entryPath);
		const firstSegment = relativePath.split(sep)[0];
		// Manifest entries must resolve back to one direct child. Besides matching the
		// managed resource model, this prevents a malformed manifest from exposing a
		// parent path as the row's uninstall/open-location target.
		if (!firstSegment || firstSegment === "." || firstSegment === "..") continue;
		roots.set(firstSegment, join(extensionsDir, firstSegment));
	}

	return [...roots.entries()].map(([source, path]) => ({
		id: `local:${source}`,
		source,
		path,
		scope: "user",
		// 内置身份只认白名单成员（-e 注入清单）：用户目录里的 pi-deck-* 不再因前缀被判
		// 成内置——插件开发复制的 demo（pi-deck-demo-plugin.ts）是用户可编辑的普通扩展，
		// 启停/卸载走普通路径；真正的内置副本（历史部署残留）仍按内置处理，由启动迁移清理。
		builtIn: isBuiltInExtensionName(source),
	}));
}

/**
 * 判断是否为本地文件扩展（~/.pi/agent/extensions 下自动发现的 .ts/目录）。
 * pi list 的包源都带 npm:/file:/github: 等协议前缀；裸文件名只能走文件系统删除。
 */
export function isLocalFileExtension(source: string): boolean {
	return !/^(?:npm|file|github|git|https?):/i.test(source);
}

export function parseListOutput(raw: string): PiExtensionSummary[] {
	const result: PiExtensionSummary[] = [];
	let scope: PiExtensionSummary["scope"] = "unknown";
	let pending: PiExtensionSummary | null = null;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (/^User packages:/i.test(trimmed)) {
			scope = "user";
			pending = null;
			continue;
		}
		if (/^Project packages:/i.test(trimmed)) {
			scope = "project";
			pending = null;
			continue;
		}

		if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
			// pi list 对「过滤式安装」的包在 source 后追加 " (filtered)" 标记
			// （settings.json 里 packages 条目是对象形式，只选择性加载列出的资源）。
			// source 必须剥离该后缀：卸载/更新/版本查询都以 source 为参数，
			// 带后缀时 pi remove / pi update / npm view 都找不到目标。
			const isFiltered = trimmed.endsWith(FILTERED_SUFFIX);
			const source = isFiltered ? trimmed.slice(0, -FILTERED_SUFFIX.length) : trimmed;
			pending = {
				id: `${scope}:${source}`,
				source,
				scope,
				...(isFiltered ? { filtered: true } : {}),
			};
			result.push(pending);
			continue;
		}

		if (pending && !pending.path) {
			pending.path = trimmed;
		}
	}

	return result;
}
