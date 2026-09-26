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
| 6 | `opencode plugin list` 不能作「加载成功」判据 | 它读后台 service 缓存（2026-09-25 实测：**会**列出配置的包插件与版本），但「没列出 / 列了」都不代表本次热重载成功——看日志 entrypoint |
| 7 | `Bun.resolveSync` 缓存负面结果 | 同进程内「先探测失败 → 再建文件」仍失败 |
| 8 | `ctx.session.synthetic` 必须 `resume: false` | 否则确定性子命令会白唤醒一轮模型；但 `false` 只是**不唤醒**，回执**仍落一条消息进历史**（占后续 token） |
| 9 | `.gitignore` 的 VS 模板 `**/[Pp]ackages/*` | 会静默吞掉 `docs/**/sources/packages/**` 归档 |
| 10 | 改完插件要**确认最新代码已加载** | 用临时探针（storage key / 工具返回标记）实测，别假设热重载生效 |
| 11 | 命令回执**人看不到** | 命令没有返回通道；给人看必须传 `synthetic` 的 **`description`**（`text` 只给模型） |
| 12 | 目标上下文**刷屏 + 历史膨胀** | 目标本体走 `hook("context")` 进 **system**（不落消息、不进转录）；驱动模型只发**一行**（`prompt` / `synthetic` 都能唤醒） |
| 13 | 插件 API 抛的是 `Schema.TaggedError`，**没有 HTTP `status`** | 判「会话是否还在」要认 `_tag`（`Session.NotFoundError`）；按 `status === 404` 判**永远不成立**，清理逻辑会静默失效 |
| 14 | `session.deleted` 的 payload **只有 `sessionID`**（不带 `location`） | 归属判定必须**豁免**它：会话已删时回落查询必然失败，否则删除事件被丢弃、KV 记录永久残留 |
| 15 | 测试里**编造**错误/事件形状 | 会遮住真 bug：我们编了 `{status: 404}`、测试助手还自动补 `location`，155 个测试全绿却漏掉两个真 bug |
| 16 | 包安装与本地目录的**入口解析路径不同** | git/npm 安装走 `exports`（且按 `files` 过滤，运行时文件必须放进 `src/`）；本地目录走 `<dir>/server`。改入口两边都要照顾 |
| 17 | 动态内容注入 **system** 会击穿 prompt 缓存 | system 只放生命周期内**逐字节不变**的内容；会变的走 messages（工具返回 / 命令回执——**二者都进模型上下文**，只是不进 system）。详见 **`prompt-cache.md`** |

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
- **命令「定义」不注入模型上下文**（源码证据：`Command.Service` 只在 `session/command.ts`（执行）、`plugin/host.ts`（插件 API）、`plugin/internal.ts`（注册）出现，`session/system-prompt.ts` 里没有任何命令清单，命令菜单也不占工具表）；**工具定义会注入**（name + description + input schema 都进模型上下文）。所以「给 agent 自主诊断」的入口只能是工具，「给人随手查」的入口用命令最干净。
  - ⚠️ 但**命令执行时的回执会注入**：所有命令输出都经 `synthetic` 落一条消息进历史（见 §6），下一轮以 `[Synthetic context]` 出现。所以「命令零上下文成本」是错觉——它只是**不进 system、不占工具表、不唤醒模型**，但**回执文本照样计费**，越短越好。
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

**包安装（npm / git）与本地目录：入口解析路径不同**（实测 2026-09-24）：

| 安装方式 | 解析 | 实测 `entrypoint` |
| --- | --- | --- |
| 本地目录 | `Host.resolve({ directory })` → `<dir>/server` → `<dir>/index`（`main` / `exports` **都不参与**） | `file:///<仓库绝对路径>/src/server.ts` |
| npm / git 包 | 经包 `package.json` 的 `exports`（`"./server"` / `"."`） | `<cache>/npm/git-<repo>-<hash>/<gen>/node_modules/<包名>/src/server.ts`（作用域包再套一层：`node_modules/@scope/name/...`） |

配套事实（均为真机实测）：

- **包安装按 `files` 过滤**：本仓库的 `"files"` 是白名单（`src/**/*.ts` + `!src/**/*.test.ts` + `server.ts` + `CHANGELOG.md`）⇒ 发布/缓存副本里**不含测试文件**，也**不含** `src/` 之外的运行时文件；注意**本地目录安装不经过这层过滤**。所以本地目录安装的入口（根 `server.ts`）不是"唯一入口"，改入口/加运行时文件时两条路径都要照顾（运行时文件必须放进 `src/`）。
- `"private": true` **不影响** git 安装（只挡 `npm publish`）。
- **同名 spec（含 ref）命中旧缓存**：代码改了也不会重拉 ⇒ 换 40 位 SHA 或清 `<cache>/npm/git-*`。
- 判定当前加载来源就看日志：`msg="loading plugin" id=<spec> entrypoint=<file://…>`。
- 顺带：`github:` 形态在 Windows 上若**不钉版本**，冷启动的更新检查会 spawn `git ls-remote` 且未加 `CREATE_NO_WINDOW` ⇒ **弹可见控制台窗口**（上游问题）；钉 40 位 commit SHA 可跳过。

### 3.2 配置安装的目标必须是目录

指向文件会打印 `configured plugin path must be a directory` 并丢弃。相对路径相对**配置文件所在目录**；也支持 `file:///...`。

### 3.3 发现式安装的布局硬约束

`packages/core/src/plugin/source-directory.ts`（`names = ["plugin", "plugins"]`）：
- 只扫 `<config>/plugin`、`<config>/plugins` 的**直接子项**，**不递归**。
- 直接子 `.ts` / `.js` 文件（或指向文件的符号链接）= 文件插件；**`.tsx` 文件不被发现**。
- 直接子**目录** = 目录插件（可含任意内部结构）。

### 3.4 安装、缓存与更新语义（源码 + 实测）

缓存布局：`<global cache>/npm/<key>/<generation>/node_modules/<包名>/`；每次安装落一个**新 generation**，取最后一个为「当前」。

| 项 | 规则（出处） |
| --- | --- |
| registry 包的 key | `<name>@<spec>`；**没写版本时 spec 归一成 `latest`**（如 `@justsilver/opencode-goal-plugin@latest`）—— `util/npm.ts` `key()` / `parse()` |
| git 源的 key | `git-<slug>-<sha256(完整 spec) 前 12 位>` |
| **启动会联网更新吗** | **不会**。加载走 `Npm.add` → `install(update = false)`：当前 generation 里**已存在**该包就直接复用返回（`util/npm.ts:258`） |
| 显式更新 | `opencode plugin update <spec 原样>` → `server.plugin.update` → `Npm.update` → arborist `preferOnline: true, noGitRevCache: true` |
| 只查不装 | `opencode plugin check` → `server.plugin.check` → `Npm.check`（registry 走 pacote `manifest()` 的 HTTP；git 走 `git ls-remote`） |
| **钉版本 = 关闭更新检测** | `parse()`：registry 的 `mutable = type !== "version"`，git 的 `mutable = !isCommit(committish)`；而 `Npm.check` 里 `if (!target.mutable) return false` ⇒ 钉了精确版本 / 40 位 SHA 就永远报「最新」 |
| 「自动更新」开关 | **不存在**。全仓 `autoUpdate` 只出现在 V1 的应用自更新配置与桌面端 electron updater，与插件无关 |

**结论**：`package` 写不写版本都**不会自动更新**；只有**不钉版本**（mutable）时才**能被检测到有新版**，再用 `opencode plugin update` 升级。要可复现就钉版本，代价是不再提示新版。

**怎么发现新版（源码 + 实测）**：

- **服务启动时会自动查一次**：`PluginSupervisor.activate()` 对每个包插件调 `PluginUpdate.check(target)`（非 refresh），结果落到 inventory 的 `source.outdated`；缓存是**进程内**的（24h 或重启失效）。
- **但 TUI 不主动提示**：`plugin.updated` 事件只让 `/plugins` 面板 refetch；`syncServerPlugins` 只对**加载失败**弹 toast，`outdated` 不弹任何通知。
- **TUI 面板**（`/plugins`，或命令面板搜 "Plugins"）：Server 段那行 footer 显示 `版本, update available`；面板内有 `check for updates`（立刻重查、覆盖 24h 缓存）与 `update`（就地升级）两个动作。
- **CLI**：`opencode plugin check` 打印 `名字 版本 (current | update available | check failed)`（走 `refresh: true`；registry 走 HTTP，无弹窗）；而 `opencode plugin list` 只有 `ID/VERSION/SOURCE` 表格，**不含**有无新版的信息。

**Windows 弹窗的真正触发点**：只有**需要解析未钉版本的 git 源**时才 spawn `git ls-remote` —— 即首次安装、以及 `opencode plugin check` / `update`。registry 包的解析与检查都走 HTTP ⇒ **npm 安装路径不会有这个弹窗**；钉满 commit SHA 的 git 源也能跳过解析。

---

## 4. 验证手段的坑（排查插件时最容易误判）

### 4.1 `opencode plugin list` 不能用来判断「加载成功」

- 它读**后台 service 的缓存**，反映的是「服务当前装着什么」，而不是「本次热重载是否成功」⇒ 「没列出」是无效信号。
- **2026-09-25 实测更正**：它**确实会列出配置里的包插件**（`ID  VERSION  SOURCE` 三列，如 `opencode-goal  0.1.0  @justsilver/opencode-goal-plugin`），发现式安装的本地插件列成 `local`。但仍是缓存视图，**判定「最新代码有没有生效」要看日志**。
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

- **`ctx.session.synthetic` 必须 `resume: false`**：否则确定性命令（如 `/goal-status`）会唤醒一轮模型。出处：`packages/core/src/plugin/plan.ts` 同样用法。
  - 注意：`resume: false` **只表示不唤醒**，消息仍会落进会话历史、下一轮被模型读到（见 §6）——它是"不额外开一轮"，不是"零 token"。
- **续跑 agent 未知时保守跳过**，绝不回退成 `"build"`（否则会把受限 agent 放行）。
- **`session.execution.interrupted` → `paused`**（宿主给定信号，非启发式）。
- **`.gitignore` 别用 Visual Studio 模板**：其 NuGet 规则 `**/[Pp]ackages/*` 会静默吞掉 `docs/**/sources/packages/**` 归档（本项目曾因此漏提交 44 个文件）。TS/Bun 项目用 `Node` 模板。
- **仓库内不留机器绝对路径**：文档、测试 fixture、配置示例一律用**相对路径或占位符**，否则换机器/换目录就失效。约定：
  - 宿主源码引用：`../Externals/opencode`（相对本仓库根）
  - 安装示例：`../opencode-goal`（相对配置文件目录），必要时用 `file:///...` 说明绝对 URL 形式
  - 测试 fixture：中性串（如 `"test-location"`），**不要**写 `C:\...` / `D:\...`

---

## 6. 命令 / 工具的输出怎么"显示给人"

**现象**：`/goal-debug env` 执行了，会话里也确实多了一条消息，但用户在 TUI 里**什么都看不到**（业务命令 `/goal-status`、`/goal-pause` 的回执同样不可见）。

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

> 推论：**每条命令回执都会增加后续 token**（并让 messages 的 tail 断点移到它身上）。所以回执要短：`/goal-debug` 输出保持一行、`statusLine` 别塞无关字段。这也解释了为什么「命令零 token」的说法只在不唤醒模型的意义上成立。

**怎么验证**：TUI 里敲 `/goal-debug env`，应出现 `◈` 开头、可换行的诊断文本；`bun test` 里 `server.test.ts` 断言了 `synthetic[0].description === synthetic[0].text`。

---

## 7. 目标上下文要进 **system**，不要进消息（否则刷屏 + 历史膨胀）

**现象**：`/goal <目标>` 的转发 prompt、以及每轮自动续跑的 continuation prompt（几千字符），会**整段**出现在 TUI 转录里，并且**每轮都往会话历史里堆一份**。

**根因（出处）**：
- `ctx.session.prompt(...)` 落成 **User 消息**，TUI 逐字渲染整段。
- 把大段 prompt 当消息发，等于**每轮持久化一次**；转录刷屏只是表象，真正的问题是上下文膨胀。

**正确做法（宿主生态里的 V2 版 `opencode2-goal-plugin` 就是这么写的）**：
1. **目标上下文走 system**：`ctx.session.hook("context", e => e.system.push({ type: "text", text }))` —— system 部分只存在于**当次请求**，不落消息、不进转录、不堆积历史。
   - 参考实现原文：`[Persisted goal]\nObjective: …\nStatus: …` 就是在这里注入的。
2. **触发只发一行**：续跑用 `ctx.session.synthetic({ text: "Continue the active goal from its current state.", description: "Goal auto-continue · <objective>", resume: true })`。
   - `text` 是给模型的行（`to-llm-message` 里 synthetic → `role: "user"`，见下）；`description` 是 TUI **唯一显示**的那行（`SessionNoticeMessageV2` 只渲染 `description`，见 §6）。
   - 宿主的 HTTP 契约（`packages/protocol/src/groups/session.ts`）：*"Durably admit synthetic session input and **schedule execution unless resume is false**"* ⇒ `resume: true` 唤醒模型，纯回执用 `false`。
   - **呈现方式二选一**（都不影响机制）：参考实现用 `ctx.session.prompt` → 显示为**普通用户消息**；用 `ctx.session.synthetic` → 显示为 `◈` **通知行**。两者都只落一行、都能唤醒模型。宿主自身偏向：`subagent-completion.ts`（通知）用 synthetic；要模型**行动**的续跑，参考实现用 prompt。
   ```ts
   case "synthetic":  // packages/core/src/session/runner/to-llm-message.ts
     return [Message.make({ id: message.id, role: "user", content: message.text })]
   ```
3. 同一套思路宿主自己也在用：`packages/core/src/session/subagent-completion.ts` 用 `synthetic({ text, description, resume })` 通知父会话（TUI 只显示 `↳ Subagent finished · <description>`）。

**实测（本仓库冒烟）**：改前每轮把 ~3000 字符的 continuation prompt 写进历史；改后每轮只落 **48 字符**触发语，目标本体在 system 里。模型仍能跨 5 轮把「1~50 分批」数完并 `complete` —— 触发语里**没有**目标，这本身就证明 system 注入生效。

**怎么验证**：设一个目标后导出会话（`opencode session export <sid>`），检查 `synthetic` 消息的 `text` 长度：续跑应恒为几十字符；目标只出现在你自己的 system 注入里。`bun test` 里 `prompts/index.test.ts` 断言 `continuationTrigger()` 是**单行**，`host/hooks.test.ts` 断言 context 钩子带上了 objective。

---

## 8. 会话生命周期：删除事件与「会话是否还在」

### 8.1 插件 API 的错误是 `Schema.TaggedError`，**没有 HTTP `status`**

实测方法：在插件里调 `ctx.session.get`，把结果写进 `ctx.storage`，再读 KV（插件 `console.error` **不进** `~/.local/share/opencode/log/opencode.log`，所以别指望日志）。

| 场景 | 抛出的对象 | 有 `status` 吗 |
| --- | --- | --- |
| 会话不存在 | `{ _tag: "Session.NotFoundError", sessionID }` | **没有**（实测 `keys = _tag,sessionID`、`status=""`） |
| id 形态非法 | `{ _tag: "SchemaError", issue, … }`（`Expected a string starting with "ses"`） | **没有** |
| 会话存在 | 正常 resolve，可读 `session.location.directory` | — |

**坑**：按 `(error as { status?: number }).status === 404` 判「会话不存在」**在插件里永远不成立**。我们因此栽过：reconcile 在真机上**从没清掉过任何一条孤儿**（冷启动也不清），而单测因为用了编造的 `{status: 404}` 一直是绿的。

**正确做法**：认 `_tag`（`Session.NotFoundError` / `SchemaError`），并保留 404/400 作为历史形态；**其它错误（500、超时、未知形状）一律当「探测失败」→ 宁可留，不可误删**。实现：`src/store/session-exists.ts`。

### 8.2 `session.deleted` 的 payload 只有 `sessionID`（不带 `location`）

- 出处：`packages/schema/src/session-event.ts` —— `Deleted` 用 `schema: Base`，`Base = { sessionID }`；对照 `Created` 才有 `location: Location.Ref`（真机事件流里 `session.created` 带 location，`session.deleted` 不带）。
- 后果：凡「先判归属、再处理」的路由都会把它判成「不属于本实例」丢掉；而此时会话已不存在，回落查询必然失败（§8.1）→ **删除事件永远被丢弃，KV 记录永久残留**。
- **正确做法**：`session.deleted` **豁免归属判定**（会话已删时归属没有意义；`remove` 幂等，多 location 实例重复执行无害）。

### 8.3 测试别编造事件/错误形状（我们就是这样骗过 155 个测试的）

三处「编造」叠起来，正好把两个真 bug 全遮住：

| 测试里的写法 | 真机形状 | 遮住了什么 |
| --- | --- | --- |
| `Object.assign(new Error("not found"), { status: 404 })`（`server.test.ts`） | `{ _tag: "Session.NotFoundError" }` | reconcile 不认 `_tag` → 孤儿永远清不掉 |
| 测试助手 `inner.handle({ location: { directory: <本实例> }, ...e })`（`events.test.ts`） | `session.deleted` **没有** location | 删除事件的归属判定被永远"补"成 allow |
| `sessionExists: async () => false`（假函数，`reconcile.test.ts`） | 真探针的抛错形状 | reconcile 的真判定根本没被测到 |

**做法**：形状必须来自**真机实测**（插件内探针 → 写 KV），并在测试注释里注明出处；测试助手不要"顺手补全"真实事件里缺失的字段。

---

## 9. 复核用命令速查

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

---

## 10. system 注入要护住 prompt 缓存（动态内容别进 system）

- **现象**：把随轮次变化的字段（token 用量、耗时、状态标签…）经 `hook("context")` 注入 system，会**每轮击穿**宿主打在「最后一个 system part」上的缓存断点——从该断点起到最新消息全部按全价重算。
- **根因（源码核实）**：宿主默认缓存策略 `{ tools, system, messages:{tail:1} }`，system 断点在**第一个和最后一个** part；断点内的缓存键是「从请求开头到断点」，任一字节变即作废。详见 **`prompt-cache.md`**。
- **正确做法**：system 只放会话/目标生命周期内**逐字节不变**的内容；会变的信息走 messages（工具返回、或 `hook("context")` 里往 `input.messages` 追加）或命令回执。
- **实测**：未修复版 16 次真实请求 system 哈希**全不同**（唯一差异是 `Tokens used`）；修复后跨 3 轮**逐字节相同**。探针方法与代码见 **`prompt-cache.md`**。
