# OpenCode v2 插件开发踩坑记录（已验证）

写这份文档的规则：**只记已经实测/源码核实过的坑**；每条都要写清「现象 / 根因（出处）/ 正确做法 / 怎么验证」，避免以后反复踩。

- 宿主源码基准：`../Externals/opencode`（相对本仓库根；分支 `v2`，`@opencode/cli@2.0.15` / `2.0.16`）
- 官方 v2 文档：<https://opencode.ai/v2/docs/build/plugins>（插件 API）、<https://opencode.ai/v2/docs/plugins>（配置与发现）
- 本文所有结论都来自：本仓库 `src/`、宿主源码、真实 `GET /api/event` 事件流

---

## 0. 速查表

| # | 坑 | 一句话 |
| --- | --- | --- |
| 1 | `session.status` / `session.idle` **后端不 emit** | 轮边界要用 `session.execution.*`；类型在 union 里 ≠ 会发出 |
| 2 | `/api/event` 是**跨所有 location** 的全局流 | 每个 location 一份插件实例，同一会话会被处理 N 次，**必须按 `event.location` 过滤** |
| 3 | `session.execution.*` **不带 `location`** | 归属回落到 `ctx.session.get({sessionID})` 查会话目录并缓存（**别**靠「等 step.started 登记」，有顺序 bug） |
| 4 | 目录插件入口 | `<dir>/server.ts` 或 `<dir>/index.ts`；`main`/`exports` 都不参与 |
| 5 | 插件目标必须是**目录** | 指向文件会被 `configured plugin path must be a directory` 丢弃 |
| 6 | `opencode plugin list` 不可作加载判据 | 它读后台 service 缓存，也不枚举配置插件 |
| 7 | `Bun.resolveSync` 缓存负面结果 | 同进程内「先探测失败 → 再建文件」仍失败 |
| 8 | `ctx.session.synthetic` 必须 `resume: false` | 否则确定性子命令会白唤醒一轮模型 |
| 9 | `.gitignore` 的 VS 模板 `**/[Pp]ackages/*` | 会静默吞掉 `docs/**/sources/packages/**` 归档 |
| 10 | 改完插件要**确认最新代码已加载** | 用临时探针（storage key / 工具返回标记）实测，别假设热重载生效 |
| 11 | 命令回执**人看不到** | 命令没有返回通道；给人看必须传 `synthetic` 的 **`description`**（`text` 只给模型） |

---

## 1. 事件与轮边界

### 1.1 `session.status` / `session.idle` 是 deprecated 定义，后端从不 emit

**现象**：把「一轮结束」建在 `session.status` 的 `busy → idle` 上，则**永远不会触发**（我们第一次冒烟就是这样：`/goal` 建目标成功，之后没有任何续跑）。

**根因（出处）**：
- `packages/schema/src/session-status-event.ts`：`session.status` / `session.idle` 定义在此，文件内标 `// deprecated`；全仓库**唯一**引用是 `packages/schema/src/event-manifest.ts` 的注册。
- 真正 publish 轮边界的是 `packages/core/src/session/execution.ts`：`session.execution.started` / `succeeded` / `failed` / `interrupted`。
- 客户端看到的 `session.status()` 状态，是拿 `session.execution.*` **推导**出来的，不是事件。

**教训**：**事件类型在 `V2Event` union（`packages/client/src/promise/generated/types.ts`）里存在，不等于后端会 emit**。当时「已核对 v2 客户端类型」正是被这一点误导。

**正确做法**：轮边界用
```
session.execution.started   → 开轮
session.execution.succeeded → 轮结束（结算 + 可续跑）
session.execution.failed    → 轮结束（结算，保守不续跑）
session.execution.interrupted → paused
```

**怎么验证**（真实事件流，不猜）：
```powershell
# 后台 service 的地址/口令
opencode pair
# 订阅真实事件流（Windows 上用 curl.exe，-N 禁用缓冲，Basic auth = opencode:<Password>）
curl.exe -N -s -u "opencode:<Password>" "http://127.0.0.1:<port>/api/event" > $env:TEMP\oc-events.log
```
实测该流里 `session.execution.started/succeeded` 各出现（每轮一对），**`session.status` 出现 0 次**。

### 1.2 哪些事件带顶层 `location`

实测统计（182 个事件）：

| 带 `location` | 不带 `location` |
| --- | --- |
| `session.created`、`session.step.*`、`session.text.*`、`session.reasoning.*`、`session.tool.*`、`session.inbox.delivered`、`project.updated` | **`session.execution.started / succeeded`**、`session.usage.updated`、`session.viewed`、`server.connected` |

→ 判定事件归属**不能只靠 execution 事件**（见 §2.3）。

---

## 2. 多 location 与全局事件流

### 2.1 宿主为**每个 location 各加载一份**插件

**根因（出处）**：
- `packages/util/src/effect/app-node.ts`：`makeLocationNode` —— location-scoped 服务图。
- `packages/core/src/plugin/supervisor.ts` 用 `makeLocationNode` ⇒ 每个 location 一个 `PluginSupervisor`，各激活一份插件。
- 官方 v2 文档（`/build/plugins`）原文：
  > `ctx.location` describes the location where **this plugin instance** is loaded. … **This is the plugin instance's location, not the location of every session it can access or event it receives.**

**现象**：日志里 `msg="loading plugin" opencode-goal` 每次重载**稳定出现 N 条**（本机 N=3，对应用户同时在用的 3 个 location）。
```powershell
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'msg="loading plugin"' |
  Measure-Object   # 每次触发一批，条数 = location 数
```

### 2.2 事件流是全局的（跨所有 location）

**根因（出处）**：
- OpenAPI 描述（`packages/protocol/src/groups/event.ts`）：
  > Subscribe to native events and plugin RPC events **across all server locations**.
- `packages/core/src/bus.ts` 的 `node` 是 **`makeGlobalNode`** ⇒ 连进程内 event bus 也是全局的（换 effect API 也一样）。
- 事件 schema 顶层有可选 `location: Location.PublicRef`（`packages/schema/src/location.ts`）。

**结论**：N 个 location ⇒ N 个插件实例**都**会收到同一会话的事件 ⇒ 不处理就 N 倍执行（我们实测**每轮注入 3 条** continuation，消息 `id` 各不相同、time 差 1–2ms）。

### 2.3 正确做法：带 location 的直接比，缺失时回落查会话

```ts
// 带 location 的事件：直接与本实例 location 比较
const directory = event.location?.directory
if (typeof directory === "string") {
  if (directory !== deps.locationDirectory) return
} else if (!(await belongsToThisLocation(sessionID))) {
  return   // 不带 location 的事件（session.execution.*）回落到查询会话目录
}

// 按会话缓存的一次查询：ctx.session.get → Session.Info.location.directory
const sessionLocations = new Map<string, string | null>()
async function belongsToThisLocation(sessionID: string) {
  const cached = sessionLocations.get(sessionID)
  if (cached !== undefined) return cached === deps.locationDirectory
  const dir = await sessionDirectory(sessionID)   // 查询失败/未知 → undefined
  sessionLocations.set(sessionID, dir ?? null)
  return dir === deps.locationDirectory
}
```

> ⚠️ **别用「等 `session.step.started` 来登记会话」的做法**（我们踩过这个顺序 bug）：`session.execution.started` **先于** `session.step.started` 到达，所以每到插件重载后的**第一轮**，`started` 都会因「归属未知」被跳过 → `turnOpen` 为空 → 轮末 `succeeded` 直接 return ⇒ **那一轮不结算、不续跑**（现象：重启后第一次设目标不续跑，之后才恢复）。用 `ctx.session.get` 回落没有这个顺序依赖。

- `ctx.location.directory`（`Location.Info`）与 `Session.Info.location.directory`（`Location.PublicRef`）都是绝对目录，Promise/Effect 都可用。
- 查询失败或会话不存在 → 视为「不属于本 location」，保守跳过。

**怎么验证**：发一条消息，真实流里 `session.execution.started` 数 = 轮数；会话里**每轮只有 1 条** continuation（不是 N 条）。

### 2.4 怎么确认「插件加载的是最新代码」+ 专用调试通道

改完 `src/**` 后**不要假设**已重载。**现在有专用入口，不用再改业务工具打探针**：

- `/goal-debug env`（人敲）或 `goal_debug(op="env")`（agent 调）：打印**本实例 location、目标会话所在目录、归属判定、以及生效的 `options`** —— 新加的选项出现在输出里，就说明最新代码在跑。
- `/goal-debug events`：最近 50 条「关心的事件 + 归属判定」，排查「没续跑 / 重复注入」直接看 `decision` 列。

实测的配套事实：
- 本地插件改文件会触发重载；日志里 `msg="loading plugin"` 每次重载出现 **N 条**（N = location 数）。
- 「看到 loading 日志」**不足以**证明加载成功——loading 在**加载开始**时打印，失败发生在其后，会额外记 `WARN failed to load plugin`。
- 插件的 `console.log` / `console.error` **不会**进 `opencode.log`；要观察内部状态就用 `/goal-debug`（或写一条全局 storage key）。
- **命令不注入模型上下文**（源码证据：`Command.Service` 只在 `session/command.ts`（执行）、`plugin/host.ts`（插件 API）、`plugin/internal.ts`（注册）出现，`session/system-prompt.ts` 里没有任何命令清单）；**工具会注入**（name + description + input schema 都进模型上下文）。所以「给 agent 自主诊断」的入口只能是工具，「给人随手查」的入口用命令最干净。
- 验证多个实例：`/goal-debug env` 看本实例 location；跨实例集合可用全局 storage 临时登记（实测本机同时加载 **3 个** location 实例。具体目录属机器相关，仓库内不记录）。
- 命令/工具的输出**必须传 `synthetic` 的 `description`** 人才看得见（只给 `text` 会变成一行空白通知），见 §6。

---

## 3. 插件入口与发现

### 3.1 目录插件的入口解析

`packages/plugin/src/host.ts` 的 `Host.resolve({ directory })` 依次解析（`main` / `exports` **都不参与**）：

| 入口 | 解析 | 约定文件 |
| --- | --- | --- |
| `server` | `path.resolve(dir, "server")`，兜底 `path.resolve(dir, "index")` | `<dir>/server.ts`、`<dir>/index.ts` |
| `tui` | `path.resolve(dir, "tui")` | `<dir>/tui.tsx` |
| `rpc`（可选） | `path.resolve(dir, "rpc")` | `<dir>/rpc.ts` |

缺入口 ⇒ `ConfigPluginSource.scan()` **静默丢弃**（无任何报错）。本仓库因此加了根 `server.ts`（`export { default } from "./src/server"`）。

### 3.2 配置安装的目标必须是目录

指向文件会打印 `configured plugin path must be a directory` 并丢弃。相对路径相对**配置文件所在目录**；也支持 `file:///...`。

### 3.3 发现式安装的布局硬约束

`packages/core/src/plugin/source-directory.ts`（`names = ["plugin", "plugins"]`）：
- 只扫 `<config>/plugin`、`<config>/plugins` 的**直接子项**，**不递归**。
- 直接子 `.ts` / `.js` 文件（或指向文件的符号链接）= 文件插件；**`.tsx` 文件不被发现**。
- 直接子**目录** = 目录插件（可含任意内部结构）。

---

## 4. 验证手段的坑（排查插件时最容易误判）

### 4.1 `opencode plugin list` 不能用来判断「加载成功」

- 它读**后台 service 的缓存**，且**不枚举配置里的插件** ⇒ 「没列出」是无效信号。
- 可靠判据：`opencode api --standalone --print-logs GET /api/plugin`，看 `msg="loading plugin"` / `WARN failed to load plugin`；必要时先 `opencode service restart`。
- `GET /api/plugin` 是 location-scoped 的（返回体里有 `location.directory`）。

### 4.2 `Bun.resolveSync` 在同进程缓存负面结果

先探测（文件不存在 → 失败）→ 再创建文件 → 重新探测**仍然失败**。真实宿主每次新进程，不受影响；自己写探针要**一次建好文件再解析**，或换进程。

### 4.3 抓真实事件流的可靠姿势

- 用 `curl.exe -N -s -u "opencode:<Password>" http://127.0.0.1:<port>/api/event`（`--max-time` 限时）。
- 用 `Start-Job` 包 `opencode api GET /api/event` 重定向到文件**可能拿不到内容**（缓冲），优先 `curl.exe` 直连。
- 事件是 SSE：`data: {...}` 每行一条；解析 `type` / `data` / `location` 即可。

### 4.4 `opencode run` 可能因模型权限直接失败

例如 `403 ... An active OpenCode Go subscription is required`。验证前先指定可用模型（`-m <provider>/<model>#<variant>`），或改用「往已有会话发 prompt」的方式。

---

## 5. 其它已验证的约束

- **`ctx.session.synthetic` 必须 `resume: false`**：否则确定性子命令（如 `/goal status`）会唤醒一轮模型。出处：`packages/core/src/plugin/plan.ts` 同样用法。
- **续跑 agent 未知时保守跳过**，绝不回退成 `"build"`（否则会把受限 agent 放行）。
- **`session.execution.interrupted` → `paused`**（宿主给定信号，非启发式）。
- **`.gitignore` 别用 Visual Studio 模板**：其 NuGet 规则 `**/[Pp]ackages/*` 会静默吞掉 `docs/**/sources/packages/**` 归档（本项目曾因此漏提交 44 个文件）。TS/Bun 项目用 `Node` 模板。
- **仓库内不留机器绝对路径**：文档、测试 fixture、配置示例一律用**相对路径或占位符**，否则换机器/换目录就失效。约定：
  - 宿主源码引用：`../Externals/opencode`（相对本仓库根）
  - 安装示例：`../opencode-goal`（相对配置文件目录），必要时用 `file:///...` 说明绝对 URL 形式
  - 测试 fixture：中性串（如 `"test-location"`），**不要**写 `C:\...` / `D:\...`

---

## 6. 命令 / 工具的输出怎么"显示给人"

**现象**：`/goal-debug env` 执行了，会话里也确实多了一条消息，但用户在 TUI 里**什么都看不到**（业务命令 `/goal status`、`/goal pause` 的回执同样不可见）。

**根因（出处）**：
- `CommandDefinition.execute` 返回 `Promise<void>`（`packages/plugin/src/promise/command.ts`；宿主侧 `packages/core/src/command.ts` 的 `Definition.execute` 返回 `Effect.Effect<void, unknown>`）——**命令没有"返回值"通道**，不能像 CLI 那样 `return "文本"` 让前端打印。
- 服务端插件**没有 toast / 通知 API**：`ctx.event` 只有 `subscribe`（`packages/plugin/src/promise/event.ts`），没有 publish；`ctx.ui.toast` 只属于 **TUI 插件**（`packages/plugin/src/tui/context.ts`），服务端插件拿不到。
- 唯一出口是 `ctx.session.synthetic(...)`，而 **TUI 只渲染 synthetic 的 `description`**。`packages/tui/src/routes/session/index.tsx` 的 `SessionNoticeMessageV2`：
  ```ts
  if (props.message.type === "synthetic") return props.message.description ?? ""
  ```
  schema 注释也写着 `description` 是 "A short human-readable summary for transcript display"（`packages/schema/src/session-message.ts`）。
- 即：**`text` 是给模型的**（会以 `[Synthetic context]` 进上下文），**`description` 才是给人看的**。

**正确做法**：给人看的回执**两个都传**：
```ts
await ctx.session.synthetic({ sessionID, text, description: text, resume: false })
```
`InlineToolLabel` 带 `flexWrap="wrap"`（`packages/tui/src/routes/session/message-parts.tsx`），所以 notice 行会**换行**显示长文本；Markdown 表格不渲染，是等宽纯文本（调试够用）。

**没有"只给人看、不进模型"的出口**：synthetic 的 `text` 会留在模型上下文里（下一轮以 `[Synthetic context]` 出现）。介意污染就改用**工具**——工具结果由 agent 转述，且只在被调用时产生。

**怎么验证**：TUI 里敲 `/goal-debug env`，应出现 `◈` 开头、可换行的诊断文本；`bun test` 里 `server.test.ts` 断言了 `synthetic[0].description === synthetic[0].text`。

---

## 7. 复核用命令速查

```powershell
# 后台 service 端点与口令
opencode pair

# 当前 location 的插件列表（含 source/features/state）
opencode api GET /api/plugin

# 抓真实事件流
curl.exe -N -s -u "opencode:<Password>" "http://127.0.0.1:<port>/api/event" --max-time 60 > $env:TEMP\oc-events.log

# 事件类型统计
Get-Content $env:TEMP\oc-events.log | ForEach-Object {
  $m = [regex]::Match($_, '"type":"([a-z][a-z0-9._]+)"'); if ($m.Success) { $m.Groups[1].Value }
} | Group-Object | Sort-Object Count -Descending

# 插件加载次数（= location 数）
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'msg="loading plugin"' |
  ForEach-Object { ($_.Line -split '\s+')[0] } | Select-Object -Last 15
```
