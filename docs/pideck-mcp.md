# PiDeck MCP 服务（API v1）

PiDeck 可作为本机 MCP 服务，向 pi 和其他兼容客户端开放**明确授权项目的只读会话数据**。它与宿主插件共用会话读取实现，但有独立的授权和生命周期，不借用插件身份、不启动或控制 pi 会话。

服务已列入 PiDeck 的 MCP 推荐服务目录，**首次使用默认关闭**：不监听端口、不创建令牌、不自动改写 pi 的 `mcp.json`。这里的“公共服务”指公开的调用接口，不是公网服务。

## 启用与接入

1. 在 PiDeck 的 MCP 配置页，选择推荐服务中的 **PiDeck（本地只读服务）**。
2. 勾选允许读取的项目，再点击“授权并启用本地服务”。授权不跟随当前选中的项目或标签变化。
3. 接入 pi：点击“添加到当前 pi 配置（禁用）”。仅新增 `pideck` 条目，保留其他服务和配置；已存在本地或继承的同名条目时不覆盖。然后在 MCP 配置中单独启用该条目，由 **pi 原生 MCP 客户端**建立连接。
4. 接入其他客户端：点击“复制连接配置”，按客户端要求填写 **Streamable HTTP URL** 和 `Authorization` 请求头。`enabled`、`exposure` 是 pi 配置项，其他客户端可能不接受它们。

导出结构示例（端口与令牌必须使用应用生成的值）：

```json
{
  "mcpServers": {
    "pideck": {
      "url": "http://127.0.0.1:<PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "enabled": false,
      "exposure": "codemode"
    }
  }
}
```

- 授权后，服务会随 PiDeck 启动恢复，端口与令牌保持不变。退出 PiDeck 后服务不可用。
- 修改授权项目或重新启用会更新令牌，旧令牌立即失效。需重新复制连接配置，手动更新已有客户端配置。
- “关闭服务并撤销令牌”会关闭监听和在途连接，并持久化关闭状态。只禁用 pi 的客户端条目**不等于**关闭 PiDeck 服务，其他持有令牌的客户端仍可访问。
- 端口占用时不会自动切换到新端口或降级为无认证服务，界面显示 `listen-failed`；可关闭服务撤销已保存的授权。配置写入失败时当前监听停止，但保存的授权可能仍存在，解决磁盘问题后应重试关闭。
- 此入口只在本地桌面主窗口可管理，Web/LAN 界面和插件 guest 无权启用或导出凭据。WSL、容器、远程客户端不保证能访问宿主 `127.0.0.1`；服务不自动扩大监听地址。

## 数据与权限边界

**任何持有令牌的客户端都能读取全部已授权项目中的可见会话，包括今后新增的会话。** 不是“仅授权当前一条会话”，也不是逐客户端授权。会话正文可能包含密钥、路径、个人信息，客户端还可能把数据发送给模型；只授权必要项目，不分享或提交连接配置。

- 服务仅绑定 IPv4 `127.0.0.1`，强制 Bearer 令牌；校验精确 Host，拒绝带 `Origin` 的浏览器请求，不提供 CORS 或 Cookie 认证。
- 只接收 `/mcp` 上的 POST，使用无状态 Streamable HTTP（JSON 响应）；握手、工具发现和 JSON-RPC 由官方 MCP SDK 处理。
- 项目只输出 `id`、`name`；会话元信息不暴露磁盘文件名。历史投影去掉 `cwd`、`parentSession`、`sessionFile`、`filePath` 字段与图片块中的二进制/引用，但**不是通用脱敏器**，不会清洗用户文字、工具结果中嵌入的秘密或路径。
- 项目删除、会话归属改变或撤权后拒绝继续访问；异步历史读取返回前再次校验授权。fork 祖先沿用宿主插件的同项目校验，不合并其他项目的源文件。
- 服务自身不执行终端命令、不读任意路径、不修改会话、不访问网络、不读取插件私有存储。没有启用服务、扩大权限或导出令牌的 MCP 工具。
- 返回的是保存的历史条目投影，不是模型请求上下文重建。历史中的用户文字、工具输出等均为不可信数据，不应当作客户端的新指令。对 `context_edit`、compaction 等条目的解释不能等同于“这是模型当前收到的消息”。

授权文件位于应用 `userData/pideck-mcp.json`，与 pi 客户端配置独立。文件仅由 `src/main/config/piDeckMcpConfig.ts` 读写，原子替换；POSIX 权限为 `0600`，Windows 依赖用户数据目录 ACL。损坏、格式不匹配或超过 256 KiB 时拒绝启动，不在读取阶段覆盖原文件。令牌不进入状态快照或日志。

## 工具契约

所有工具带 `readOnlyHint: true`、`destructiveHint: false`。项目和会话 ID 必须来自列表结果，不能传文件路径代替；对象入参拒绝未声明字段。

成功同时返回 MCP `content`（JSON 文本）和 `structuredContent`：

```json
{ "apiVersion": 1, "data": "<各工具的返回值>" }
```

| 工具 | 参数 | `data` |
| --- | --- | --- |
| `projects_list` | 无；`arguments` 可省略或传 `{}` | `[{ id, name }]`，仅授权项目 |
| `sessions_list` | `projectId`，可选 `offset`（默认 0，整数 0–100000） | `{ sessions, nextOffset }`，每页最多 100 条，按更新时间倒序 |
| `sessions_get` | `projectId`、`sessionId` | 单个会话元信息 |
| `sessions_search` | `projectId`、`query`（1–500 字符），可选 `limit`（默认 20，1–100） | 会话元信息数组；标题的不区分大小写子串搜索，**不是全文搜索** |
| `sessions_entries` | `projectId`、`sessionId`，可选 `cursor` | `{ entries, nextCursor, version, truncated }` |

会话元信息：`id`、`projectId`、`title`、`createdAt`、`updatedAt`、可选 `model`、`readable`。时间戳为毫秒。列表仅包含对应项目中已保存、未被替代的会话；草稿不在列表中。DSH 会话可有元信息，但 `readable: false`，不会通过此接口读取历史。

### 历史分页

`sessions_entries` 读取保存文件的活动分支，**先返回最新一页，每页内部按时间顺序**。继续向前读取时把 `nextCursor` 原样传给 `cursor`，不要自行生成：

```json
{
  "projectId": "<PROJECT_ID>",
  "sessionId": "<SESSION_ID>",
  "cursor": { "before": 100, "version": "<OPAQUE_VERSION_FROM_RESPONSE>" }
}
```

- 每页最多 100 条，原始条目读取字节预算 1 MiB，单条最多 256 KiB。
- 超大条目以 `{ id, type, parentId, omitted: "entry-too-large" }` 代替，`truncated: true`。图片载荷不会返回；不要把 `truncated: false` 理解为完全未经投影的原始文件。
- 历史索引预算为含 fork 祖先在内的 **64 MiB / 100000 条**，超限拒绝而不是退化成全量读取。
- `nextCursor: null` 表示没有更早的一页。文件追加或改写会使游标失效，收到 `stale-cursor` / `history-changed` 后从不传游标的新读取开始。
- HTTP 请求体最多 64 KiB，同时最多 4 个请求/读取操作、32 个连接。拒绝批量 JSON-RPC；断开连接不会提前释放仍在读取的 IO 名额，避免不断取消绕过预算。

### 错误处理

领域错误以 `isError: true` 和 `content[0].text` 中的 JSON `{ "code": "..." }` 返回：

| 错误码 | 含义 / 处理 |
| --- | --- |
| `access-revoked` | 服务关闭或本次授权已失效；停止请求并检查授权 |
| `project-not-authorized` | 项目不在授权范围或已移除 |
| `session-not-authorized` | 会话不存在、不属于指定项目或不可见；不泄露其他项目存在性 |
| `history-unavailable` | 无可读保存文件（例如 DSH） |
| `history-too-large` | 超出历史索引预算 |
| `stale-cursor` / `history-changed` | 历史版本变化；丢弃旧游标重新读取 |
| `invalid-offset` | 分页偏移不合法 |
| `operation-failed` | 其他错误；不向客户端返回路径、堆栈或原始异常 |

协议/参数格式错误由 MCP SDK 返回。HTTP 层可能返回 401（凭据无效）、403（Host/Origin 不被允许）、413（请求体超限）、429（并发已满）。关闭/撤权也可能直接断开请求；客户端不能无限立即重试。

## 客户端组合示例

以下代码用于已有 `@modelcontextprotocol/sdk` 的 Node 客户端。URL/令牌从客户端自己的安全配置注入，不能写入仓库；同样不要把读取到的正文直接写进公共日志。

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-pideck-integration", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PIDECK_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.PIDECK_MCP_TOKEN}` } },
  }));
  const result = await client.callTool({ name: "projects_list", arguments: {} });
  if (result.isError) throw new Error("PiDeck tool rejected the request");
  // 使用 result.structuredContent.data 中的项目 ID 调 sessions_list / sessions_entries。
} finally {
  await client.close();
}
```

用户可在客户端构建标题搜索、会话汇总、知识整理等工作流。首版**不动态加载用户自定义服务端代码**；新增内置工具的维护入口是 `src/main/mcp/piDeckMcpTools.ts` 的注册函数，必须复用独立授权、严格参数校验、安全错误和资源预算，并同步 API 文档与针对性测试。新增写能力或权限不是“注册一个工具即可”，必须另行设计授权。

## 实现与验证入口

- `src/main/mcp/PiDeckMcpService.ts`：授权、令牌、启动/关闭与重启恢复。
- `src/main/mcp/PiDeckMcpHttpServer.ts`：回环 HTTP、认证、请求限额。
- `src/main/mcp/piDeckMcpTools.ts`：API v1 工具；会话行为复用 `HostPluginSessions`。
- `src/main/ipc/piDeckMcpIpc.ts`：只允许桌面主窗口主帧管理。
- `src/renderer/src/config/PiDeckMcpPanel.tsx`、`src/renderer/src/hooks/usePiDeckMcp.ts`：显式授权与敏感配置交接。

```sh
node --test tests/piDeckMcp.test.mjs tests/piDeckMcpIpc.test.mjs tests/piDeckMcpUi.test.mjs tests/mcpServiceCatalog.test.mjs
```

测试使用隔离临时目录、真实 MCP SDK 客户端和本机临时端口，不读写用户配置、不调用模型或连接外部服务。
