# 规格：goal 回执零 token —— TUI 提示显示

> 状态：**已实现**（2026-09-26，`src/rpc.ts` + `src/tui.ts` + `src/server.ts`；显示机制见 §16 实现偏差）。日期：2026-09-26（重写，取代前一版"TUI 状态条/面板"设计）。
> 一句话：**命令全部保留在服务端（名字、行为、可用性不变）**，仅把回执从 `synthetic`（写会话消息 → 进模型、花 token）改为 **TUI toast 浮条**（`ui.toast.show` → 不进模型）。无 TUI 时命令照旧静默执行，不炸、不丢能力。

---

## 1. 背景与问题

### 1.1 命令回执为什么必然花 token

服务端命令**没有返回值通道**（`CommandDefinition.execute` → `Promise<void>`），服务端插件**也没有 toast / 弹窗 API**。唯一输出是：

```ts
ctx.session.synthetic({ sessionID, text, description, resume: false })
```

这条消息天生一半给人、一半给模型：`description` → TUI 显示；`text` → 落会话历史、下一轮以 `[Synthetic context]` 进**模型上下文**（花 token、污染思维链）。

即：**命令唯一的那条显示通道，恰好就是会喂模型的那条**（已核实，见 `docs/opencode/plugin-dev-gotchas.md` §6）。

### 1.2 硬约束

- **不允许任何额外 token 开销**（不只是钱：多出的消息影响模型思维链）。故所有回执**不得进模型**（连空 `text` 消息也不行）。
- **命令不变**：名字、行为、所有客户端（TUI / API / 脚本）可用性都不变。
- **无 TUI 不炸**：纯 API / headless 下命令照旧可用。

### 1.3 宿主事实（源码核实，见 §11 出处）

- `SessionMessage.Synthetic.text` **必填**，`to-llm-message` 把它作为 `role:"user"` 送进模型；`description` 只用于转录显示、**永不进模型**——但**无法单独发送**。
- **没有"只显示、不进模型"的消息类型**（→ §15 提 issue 的依据）。
- 命令菜单一旦注册就出现在 `/` 列表，**插件无法隐藏**；因此**不能**保留命令却让它"没反应"。
- TUI 的 `ui.dialog.alert / confirm / prompt / select` **由宿主渲染，插件只传数据 → 不需要 JSX/Solid**（绕开"双 Solid 运行时"地雷）。
- 一个包可同时具 `server` 与 `tui` 入口；TUI 会自动纳入 server 插件清单里 `features.tui === true` 的包（**无需写 `cli.json`**）。
- RPC 定义/注册/调用可用；**RPC 事件可推送**；RPC 可经 **HTTP** 调用（`POST /api/rpc/{id}/{method}`，本地无密码免鉴权）。

---

## 2. 目标 / 非目标

### 目标

1. 所有 goal 命令**保留在服务端**，名字与可用性不变。
2. 命令回执**不再写会话消息**（0 token），改由 **TUI 弹窗**显示。
3. 无 TUI（API / headless / 脚本）时命令**照旧执行**，不报错。
4. 不改目标语义、状态机、续跑、预算、system 注入。

### 非目标

- 不做常驻状态条 slot / 面板 / 快捷键（**已否决**：slot 需 JSX → 双 Solid 风险）。
- 不改命令名、不新增 `/XXX` 命令。
- 不做"只显示不进模型"的会话内消息（宿主无此能力）。

---

## 3. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 0 额外 token 为硬约束 | 用户要求 |
| D2 | 回执改 **TUI 弹窗**（`ui.dialog.alert`） | 不进模型；宿主渲染、无需 Solid |
| D3 | 命令**全留服务端**，名字/行为/可用性不变 | 用户要求；API/headless 不炸 |
| D4 | 服务端不再 `synthetic` 回执；改为 **RPC 事件**推送结果 | 0 token；TUI 据此弹窗 |
| D5 | 无 TUI 时命令**静默执行** | 不炸、不丢能力 |
| D6 | `/goal <目标>` 行为**不变**（`synthetic resume:true`） | 派活给模型，本就该进模型 |
| D7 | 不使用 slot / 面板 / 状态条 / 快捷键；TUI 侧**不引入 Solid/JSX** | 绕开"双 Solid"地雷，配置安装安全 |

---

## 4. 架构

```
opencode-goal（同一包 / 同一 id / 配置一行不变）
├── server 侧：命令（全部，不变）、数据KV、system注入、续跑、RPC 注册与事件发射
└── tui 侧：订阅 RPC 事件 → ui.dialog.alert 弹窗（不渲染 JSX、不碰 Solid）
```

- 双入口：`exports["./server"]`（现有）+ `exports["./tui"]`（新增）；`exports["./rpc"]`（纯 schema，供 import）。
- 命令全部在 server 注册（`ctx.command`）——**不搬到 TUI**。
- server 侧持有 RPC 定义并 `register` + `events.emit`；tui 侧用 `context.client.rpc(Def)` 订阅事件。

### 命令面（不变）

`/goal <目标>`、`/goal-status`、`/goal-pause`、`/goal-resume`、`/goal-clear`、`/goal-budget`、`/goal-rebuild`、`/goal-debug` —— **名字与行为照旧**（仅显示方式改变）。

---

## 5. RPC 契约（拟）

`src/rpc.ts`（纯 schema，`@opencode/plugin/rpc` 导出 `Rpc`）：

```ts
export const GoalRpc = Rpc.define({
  id: "opencode-goal",
  methods: {
    // TUI 若需要主动拉取（如弹窗里点「查看详情」），可留；命令路径不依赖它
    status: { input: { sessionID }, output: { line: string } },
  },
  events: {
    // 命令回执：服务端发射 → TUI 弹窗
    notice: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string", enum: ["info", "success", "warning", "error"] },
        },
        required: ["sessionID", "message"],
        additionalProperties: false,
      },
    },
  },
})
```

- server：`const reg = await ctx.rpc.register(GoalRpc, { status: ... })`；命令执行后 `await reg.events.emit("notice", { sessionID, title, message, variant })`。
- tui：`const api = context.client.rpc(GoalRpc); api.events.on("notice", (e) => context.ui.dialog.alert({ title: e.title ?? "Goal", message: e.message }))`。
- `message` 为**已本地化**文本（复用 `i18n` / `statusLine`）。

---

## 6. TUI 侧（极简）

- `src/tui.tsx`：`Plugin.define({ id, setup(context) {...} })`。
- setup 内：
  1. `const api = context.client.rpc(GoalRpc)`；
  2. `api.events.on("notice", cb)`；`cb` 调 `context.ui.dialog.alert({ title, message })`。
  3. 清理订阅（`onCleanup` / cleanup 返回）。
- **不注册 slot、不渲染 JSX、不 import Solid / OpenTUI** → 无"双 Solid"风险。

---

## 7. 服务端改动

| 位置 | 现状 | 改为 |
|---|---|---|
| `notify`（各命令回执） | `synthetic({ text, description, resume:false })` | **不发消息**；组装文本 → `events.emit("notice", …)` |
| `/goal <目标>`（`deliver`） | `synthetic({…, resume:true})` | **不变** |
| 命令注册 | 8 条 | **不变**（全留） |
| RPC | 无 | 新增 `ctx.rpc.register(GoalRpc, …)` + 事件发射 |
| 续跑 / 记账 / system 注入 / 事件 | — | 不变 |

> 回执文本的来源不变：`statusLine(...)` 等；只是出口从会话消息改成事件。
> 若 RPC 尚未注册（异常情况），回执降级为**静默**（仍 0 token、不报错）。

---

## 8. 无 TUI（API / headless）行为

- 命令**照旧可用**：执行数据变更，回执事件**无人订阅**（无副作用）。
- 不报错、不产生会话消息、0 token。
- 脚本/IDE 需要结果时：走 RPC over HTTP（`POST /api/rpc/opencode-goal/status`）或 `goal(op="get")`。

---

## 9. 打包与发布

- `package.json`：
  - `exports`：加 `"./tui": "./src/tui.tsx"`、`"./rpc": "./src/rpc.ts"`（保留 `"."`/`"./server"`）。
  - `files`：加 `tui.ts`（本地目录转发器）、`src/tui.tsx`、`src/rpc.ts`。
  - **不新增 `dependencies`**；**不声明** `solid-js` / `@opentui/*`（避免被装进插件 `node_modules` → 双 Solid）。
- 本地目录安装：新增根 `tui.ts` 转发器（对齐 `server.ts` 模式）。
- `tsconfig`：`src/tui.tsx` 若含 JSX 才需要 jsx 配置——**本设计不含 JSX**，故现有配置即可；`@opencode/plugin/tui` 的类型来自 devDependency `@opencode/plugin`（已有）。
- 单包单 tag；CD 不变。

---

## 10. 兼容与迁移

- 命令名、配置项、工具名、`/goal` 行为**全部不变**（非破坏性）。
- 唯一可感知变化：命令回执从"会话里一行通知"变成"TUI 弹窗"；无 TUI 时不显示（以前显示在会话里）。
- CHANGELOG 写明该行为变化。
- 若 RPC 事件在本机不可用（§11 V1），退化为"静默回执"（仍是 0 token）。

---

## 11. 未验证清单

> **2026-09-26 真机实验：V1 / V2 / V3 全部通过**（最小双入口探针包，配置安装，见 §11.1）。

| # | 项 | 状态 |
|---|---|---|
| V1 | TUI 侧订阅 RPC 事件（`context.client.rpc(Def).events.on`）并收到 server `emit` | ✅ **通过** |
| V2 | `ui.dialog.alert` 支持多行文本 | ✅ **通过**（三行正常显示） |
| V3 | 配置安装（`opencode.json`）的包，其 `exports["./tui"]` 被 TUI 自动纳入并加载 | ✅ **通过** |
| V4 | 同名命令冲突 | 不适用（命令不搬 TUI） |
| V5 | 事件在"命令执行瞬间"TUI 未就绪/未连时丢失的行为 | 未验（兜底可接受：操作已生效，重敲可见） |

### 11.1 实测记录（2026-09-26）

探针包（临时目录，已删）：`package.json`（`exports: {"./server","./tui","./rpc"}`）+ `server.ts`（`ctx.rpc.register` + `/probe-pop` 命令 → `reg.events.emit("notice", …)`）+ `tui.ts`（`context.client.rpc(Def).events.on("notice", …)` → `ui.dialog.alert`）。

- 挂到 `~/.config/opencode/opencode.json` 的 `plugins`（`file:///…`）后**自动热重载**；`opencode plugin list` 出现该包、日志 `msg="loading plugin" … entrypoint=…/server.ts` 无报错。
- TUI 里敲 `/probe-pop` → **弹出弹窗**，多行正文正常。
- 全程**无 synthetic 消息**（命令只发 RPC 事件）。
- ⚠️ **坑**：`events.on` 回调参数是**包装对象**，payload 在 `event.data`（类型 `RpcEventPayload = { type: "rpc.<id>.<name>", data: {…} }`）；写成 `event.message` 会得到 `undefined`（首测正文为空，标题落到兜底值）。
- 方案成立，无需改动"命令全留服务端 + 事件 → 弹窗 + 无 TUI 静默"的设计。
- 结论同时记入 `docs/opencode/plugin-dev-gotchas.md` 速查表。

---

## 12. 分阶段交付

- **阶段 0**：验证 V1/V2/V3（最小双入口包 + 一次命令弹窗）。
- **阶段 1**：`src/rpc.ts` + server 事件发射 + `src/tui.tsx` 弹窗；回执文本改造；无 TUI 静默。发布 0.x.0。
- **阶段 2（可选）**：`/goal-debug` 长文本改用 `dialog.select` 分页或 `prompt`；`/goal-clear` 加 `confirm`（注意：命令已执行，确认须在 TUI 侧另设入口，否则不做）。

---

## 13. 验收标准

1. `/` 菜单里 8 条 goal 命令**全部还在**，名字不变。
2. 敲 `/goal-status` 等 → **弹出 TUI 弹窗**显示结果；**会话历史无新增消息**。
3. 探针：命令执行前后，发往 provider 的请求体**逐字节一致**（无新增消息）。
4. 纯 API / 无 TUI：命令可用、无报错、无 synthetic、0 token。
5. `/goal <新目标>` 行为不变。
6. `bun test` / `tsc --noEmit` / changelog check 全绿。

---

## 14. 风险

- **R1**：RPC 事件丢失 → 偶发不弹窗（操作已生效；重敲命令可再现）。可接受。
- **R2**：`dialog.alert` 文本长度受限 → 长诊断（`/goal-debug`）可能需二次方案（阶段 2）。
- **R3**：TUI 入口在某些宿主版本/远程模式下未加载 → 回执无声（命令仍可用）。README/CHANGELOG 说明。

---

## 15. 待办（Todo）

- [ ] **全部交付后**，向 opencode 提 feature request：希望提供「只发给用户看（`description`）、不进模型上下文」的输出通道。
  - 草稿与证据见 `docs/opencode/known-issues.md` 的「上游功能请求（待提 issue）」一节（含 `text` 必填、`to-llm-message` 进模型、命令无返回值通道、服务端无 `ui.*`）。
- [ ] **发布后** `npm deprecate` 旧版本（若本版为破坏性；本设计预期非破坏性，按实际决定）。

---

## 16. 实现偏差（2026-09-26 实测后调整）

§1–§15 是设计时的方案（`ui.dialog.alert` 弹窗）。真机实测暴露两个宿主事实，遂在实现阶段改成 **`ui.toast.show`**：

| 实测问题 | 根因（源码） | 最终做法 |
|---|---|---|
| 敲一次命令，**所有 TUI 窗口都弹窗** | 事件是 bus **广播**给同一 location 下所有 TUI 客户端；`dialog.alert` 是客户端全局模态、不看会话 | TUI 侧按 `ui.router.current()` + `data.session.root()` **过滤**：只有正看着该会话的窗口才提示 |
| 长正文（`/goal-status`、`/goal-debug`）**溢出**、无滚动 | `ui/dialog-alert.tsx` 是普通 `<text>`，容器 `ui/dialog.tsx` 无 scrollbox；非 JSX 通道里唯一可滚的是 `dialog.select` | 改用 **toast**（非模态、自动消失、宿主自带会话判定），并在**服务端** `notify` 里用 `clampNotice`（按约 54 列 × 12 行估算）**截断**，超出折叠成「… 还有 N 行」 |

补充事实（同时记入 `docs/opencode/plugin-dev-gotchas.md`）：toast 同样**没有** `maxHeight`/滚动，不主动截断就会超屏被硬裁；社区同类插件（`prevalentWare/opencode-goal-plugin`、`Hotakus/opencode-visual-cache`）的命令回执也都是 `ui.toast.show`。

§12 阶段 2 的「`dialog.select` 分页」不再需要（改由 `clampNotice` 截断）。

### 16.1 预算用尽「静默」修复（同日）

实测发现：**预算命中后没有任何回执**（模型直接停、用户不知原因）。原因是预算命中由插件自己在 `events.ts` 的 `save()` 里跑 `applyBudget` 判定，而 `announce(signalNotice(...))` 只在 `session.execution.failed`（宿主信号：用量超限等）分支里调用——预算那条路径没人发。

修复（保持「停摆回执走会话消息、命令回执走 toast」的分工）：
- `save()` 检测 `active/blocked/usage-limited → budget-limited` 的跃迁，发一次**合成回执**（`text` 进模型 + `description` 给人看，落转录）。
- `session.execution.failed` 分支不再重复通知 `budget-limited`（避免同一停摆两次），只负责宿主信号直接造成的 `usage-limited` / `blocked`。
- 事件路由的注入端口从「toast 用的 `notify`」换成「合成用的 `announce`」；命令面仍拿 `notify`。

### 16.2 停摆回执必须 `resume: true`（同日，§16.1 的修复其实没送达）

§16.1 上线后真机复测：**人和模型依然什么都看不到**。根因不在文案，而在 `session.synthetic` 的**投递语义**（源码核实）：

| 事实 | 出处 |
|---|---|
| 合成消息的**转录行**是**投递**（`InboxDelivered`）时才建的；入队（`InboxEnqueued`）只写一条 inbox 行 | `core/src/session/projector.ts`（`InboxEnqueued` → `projectAdmitted` 只写 inbox 表；`InboxDelivered` → 建 `synthetic` 消息） |
| `resume: false` **不唤醒**会话（只有 `resume !== false` 才 `execution.wake`） | `core/src/session/session.ts` 的 `Session.synthetic` |
| 轮末 `session.execution.succeeded` 在**整个忙期 settle 之后**才发（"One terminal observation per busy period"） | `core/src/session/execution.ts` 的 `settled` |
| 时间线只渲染 `type:"user"` 的 pending 项，synthetic 的 pending **完全不可见** | `app/src/session/timeline/controller-projection.ts` 的 `visibleTimelineMessages` |

于是停摆回执（恰好在忙期已 settle 时入队）**没有任何 drain 会来投递它**：转录不建行、模型上下文也没有 → 等于没发。停摆通知因此**必须自己制造一次投递**，即 `resume: true`（代价：一轮模型调用）。

最终做法（0.5.0）：
- `announce` 改 `resume: true`，并把两个字段分工：
  - `description` = `signalNotice(...)`（本地化，给人看、留在转录里）；
  - `text` = 新增 `prompts.stopWrapUpPrompt(reason)`（不本地化，明确要求模型**只做简短收尾、不调工具、不改状态**），让那一轮不是白跑。
- 调用方只传 `{ reason: StopReason; message }`，文案组装收敛到 `server.ts`（`StopReason` 定义在 `model/types.ts`）。
- 唤醒只在跃迁时发一次，且 `applyHostSignal` 对已是终态的目标是 no-op → 不会形成续跑/通知循环。
- 真机实测（`ses_f22915004ffe…`）两条路径均通过：
  - **命令路径**（`/goal-budget` 设到已用量之下）：转录出现 `synthetic desc=目标已标记为预算用尽…` + 其后一轮 assistant 收尾，之后无续跑；
  - **自然路径**（轮末结算时自然越界，即原始场景）：`tokensUsed=657938 ≥ tokenBudget=644930` → `budget-limited`，同样出现该回执与**恰好一轮**收尾（模型回复「已完成 1–36 / 剩余 37–100 / 下一步 提高预算」）。
