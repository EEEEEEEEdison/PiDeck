/**
 * 应用品牌名（面向用户可见的系统级文案：通知标题等）。
 *
 * 为什么要有这个常量：`app.getName()` 取的是运行时 package.json 的 `name`/`productName`，
 * 而打包进 asar 的 package.json 只有 npm 包名 `name: "pi-desktop"`（electron-builder 的
 * `build.productName: "PiDeck"` 不会写进 asar），因此**安装版**的系统通知标题会显示
 * `pi-desktop`；dev 态更是随目录名变化（`pi-desktop-dev-<branch>`）。
 * 品牌名是产品事实、不该随打包元数据漂移，故在此固定一处，通知站点统一引用。
 */
export const APP_DISPLAY_NAME = "PiDeck";
