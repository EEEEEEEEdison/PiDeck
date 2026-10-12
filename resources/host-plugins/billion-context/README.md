# billion-context（PiDeck 内置示例插件）

查看并启停 [billion-context](https://www.npmjs.com/package/billion-context) 的本地代理（`bili`），
并用 PiDeck 的内置浏览器打开它的 Web 面板 `/__bili/`。

## 前置条件

billion-context 需要自行安装，PiDeck 不会替你装：

```bash
npm i -g billion-context
```

装好后本面板会显示「未运行」，点「启动」即可。

## 这个插件做了什么

| 按钮 | 行为 |
| --- | --- |
| 启动 | 主进程执行 `bili` 起一个常驻代理，轮询 `bili doctor --json` 直到报告进程存活（最多 20 秒） |
| 停止 | 按 `bili doctor --json` 报告的 pid 终止进程（外部 CLI 没有 `stop` 子命令，只能按 pid） |
| 打开面板 | 用 PiDeck 的内置浏览器打开 `http://127.0.0.1:<port>/__bili/` |

端口不写死：以 `bili doctor --json` 的 `processes[].port` 为准（默认配置 8788，pi lane 自拉代理时常落在 28800）。

## 权限说明

清单里只声明了 `service.local`，并点名了 `billion-context`：

```json
"permissions": ["service.local"],
"services": ["billion-context"]
```

- 插件本身**没有**执行任意命令的能力。命令名、参数、端口都在 PiDeck 主进程的服务适配器里，插件只能点名服务 id。
- 未在 PiDeck 里实现适配器的服务，写进 `services` 也会被清单校验拒绝。
- 插件页面 CSP 是 `connect-src 'none'; frame-src 'none'`，所以它**不能**内嵌这个面板；「打开面板」是把 URL 交给 PiDeck 去开内置浏览器。

## 安全提醒

bili 的 Web 面板只监听 `127.0.0.1` 且**没有鉴权**。不要把这个端口暴露到公网或局域网。

## 改这个插件

这是普通宿主插件，直接改目录里的文件即可；改完回 PiDeck「PiDeck 插件」设置页点「重新扫描」。
因为授权绑定整包代码指纹，内容一变就需要重新确认授权。

API 参考见 PiDeck 仓库的 `docs/host-plugin-dev-guide.md`。
