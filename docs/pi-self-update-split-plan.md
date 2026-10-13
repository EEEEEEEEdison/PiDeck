# pi 自更新链路拆分计划（ExtensionManager 瘦身）

> 状态：**Wave 1 已落地（2026-10-13）**；Wave 2 待做。基线 `src/main/extensions/ExtensionManager.ts` 1254 行 → Wave 1 后 1216 行（红线 400/600 的 3 倍）。
> 触发：2026-10 修 bun/WSL 更新通道时，「检查 → 分派 → 失败提示 → 包管理器代跑」这一段已达 ~280 行，且与扩展目录/安装域同处一文件，按 AGENTS.md 的文件体量红线需要评估拆分。
> 长期目标：自更新链路收口为 `src/main/pi/piSelfUpdateRunner.ts`（纯判定与命令构造已在 `piSelfUpdateChannel.ts`），ExtensionManager 只保留 spawn 装配、扩展管理域与薄包装，最终 ≤600 行。

## 拆分纪律（沿用 app-tsx / agent-manager 的既有方法）

- 每波一个域，独立可验证：`npm run typecheck` + 该域契约测试全绿 + 引用扫描（`grep -rln "ExtensionManager" tests/` 现为 8 个文件；改动方法所属域的测试必须同步换 seam）。
- 行为零变化：纯搬家 + 委托，命名与注释随迁；不顺手改语义、不改 IPC 契约、不改用户可见文案。
- 协作者不反向 import ExtensionManager：依赖全部构造注入（`locator` / `getSettings` / `translate` / `sanitizeCommandOutput` / `runPi` 回调 / 版本缓存失效回调 / `execFile`）。
- 行数单调下降才算一波完成；每波独立 commit，便于 `git revert`。

## Wave 1（已落地，2026-10-13）

| 域 | 新模块 | 迁出内容 | 接线点 |
|----|--------|---------|--------|
| 通道判定 + 安装命令构造 + bun 版本解析 | `src/main/pi/piSelfUpdateChannel.ts`（134 行，纯函数、零 Electron/磁盘依赖） | `resolvePiSelfUpdateChannel`、`resolveBunInstallRoot`、`npmGlobalInstallArgs`、`bunGlobalInstallArgs`、`parseBunVersion`、`isLocalAbsolutePath`、`PI_OFFICIAL_REGISTRY`、`BUN_MIN_VERSION_FOR_RELEASE_AGE_FLAG` | `updatePi` 分派与 `channelLabel` 改为同一 argv 构造器渲染；提示命令与代跑共用构造器；`tests/piSelfUpdateChannel.test.mjs` 直接测构造器 |

结果：ExtensionManager 1254 → 1216 行；`channelLabel` 不再单独维护第三份「通道 → 命令」映射（这是 2026-10 提示与代跑参数漂移的根因）。

## Wave 2（待做）：自更新执行链路 → `src/main/pi/piSelfUpdateRunner.ts`

| 迁出内容（ExtensionManager 现行号） | 说明 |
|---|---|
| `checkPiUpdate`、`checkPiUpdateFor`(570)、`fetchPiLatestVersion`(835) | 更新检查 + pi.dev 版本接口（Electron `net.fetch`，代理生效） |
| `updatePi`(593)、`withUpdateFailureHint`(652) | 通道分派 + 三类失败提示（源未同步 / 发布年龄门 / 其余透传） |
| `runPackageInstall`(669)、`pickBunCommand`(705)、`runBunGlobalUpdate`(720)、`bunSupportsReleaseAgeFlag`(731)、`runNpmPrefixUpdate`(746) | 包管理器代跑（bun / npm 前缀）与 bun 版本探测 |
| 常量 `PACKAGE_MISSING_VERSION_PATTERN`、`RELEASE_AGE_BLOCK_PATTERN`、`PI_LATEST_VERSION_URL`、`PI_LATEST_VERSION_TIMEOUT_MS` | 失败文本分类与检查超时 |

Wave 2 保留在 ExtensionManager（不迁）：

- `runPi`(1094)：`--no-approve` 判定、PATH/代理环境装配、WSL 处理，扩展 list/install/uninstall 也在用 → 以回调注入 runner；
- `npmViewVersion`(870)（扩展版本查询）与 `sanitizeCommandOutput`(932)（多条链路共用）→ 注入；
- `toUpdateResult`(936)（`updateExtensions` 也用）→ 保留，runner 返回原始结构由薄包装转换；
- `piVersion` / `piVersionPromise` 字段与 `PiProcess.invalidateVersionCache()` 调用 → 以回调注入（runner 的 `finally` 里调）。

受影响契约测试（Wave 2 必须同步换 seam）：

- `tests/extensionManager.test.mjs`：`manager.runPi`(13 处) / `manager.runBunGlobalUpdate`(9) / `manager.runPackageInstall`(3) / `manager.runNpmPrefixUpdate`(3) / `manager.pickBunCommand`(3) / `manager.checkPiUpdateFor`(1) / `manager.locator`(1)；
- `tests/piCliUpdates.test.mjs`：`manager.fetchPiLatestVersion`(2)；
- 只用公开 API 的用例不受影响：`updatePi` / `checkPiUpdate` / `updateExtensions` / `updateExtension`。

门禁（Wave 2 完成判据）：ExtensionManager ≤ 1000 行、`piSelfUpdateRunner.ts` 单向依赖 `piSelfUpdateChannel.ts`、上述测试全绿且不再直接 stub 已迁出的私有方法。

## Wave 3（远期）：扩展目录与安装域

`loadList`(252)、`scanLocalExtensions`(350)、`install`、`uninstall`、`setEnabled`、本地文件扩展增删、`listCache*`/`listRequestSequence` 状态 → 抽 `piExtensionCatalog.ts`；届时 ExtensionManager 只剩 `runPi`/spawn 装配与薄包装，目标 ≤600 行。

## 验证与回滚

```bash
npm run typecheck
npm run check:format
node --test tests/piSelfUpdateChannel.test.mjs tests/extensionManager.test.mjs tests/piCliUpdates.test.mjs \
  tests/piUpdateStartupNotice.test.mjs tests/extensionManagerWsl.test.mjs tests/logAudit.test.mjs
```

- 源码契约测试扫描：迁移后重跑 `grep -rln "ExtensionManager" tests/`，逐文件确认是「换 seam」而不是「删断言」。
- 回滚：每波一个 commit，行为零变化，`git revert <wave-commit>` 即可回到上一波。
