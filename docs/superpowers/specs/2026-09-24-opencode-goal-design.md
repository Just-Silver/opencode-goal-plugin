# opencode-goal 插件设计（v1）

- 日期：2026-09-24
- 状态：已定稿（自审通过，2026-09-24）
- 宿主：**OpenCode V2**（分支 `v2`，`@opencode/plugin@2.0.x`；宿主源码检出 `../Externals/opencode`，相对本仓库根）
- 参考：Codex `ext/goal`、OMP `packages/coding-agent/src/goals`（见 `docs/codex/`、`docs/omp/`）

## 1. 目标与非目标

**目标**：给 OpenCode 加 Codex/OMP 式的持久目标能力——`/goal` 命令 + 单一 `goal` 工具 + 空闲续跑 + 证据式完成 + 阻断/预算护栏，**server 侧插件**、**配置安装一行生效**。

**非目标（v1 不做，阶段二或永不）**：TUI 侧边栏；v1 兼容；`usage-limited`；宿主终态错误自动 `blocked`；子会话 deferral；i18n；遥测；跨会话列表。

## 2. 分发与安装

- 配置安装：`opencode.json(c)` 的 `plugins` 数组，object 形式带 options：
  ```jsonc
  { "plugins": [ { "package": "@you/opencode-goal", "options": { /* 见 §11 */ } } ] }
  ```
  （包名 `@you/opencode-goal` 为示例，发布前定名。）
  - 字符串形式 `"@you/opencode-goal"` 亦可用，options 取默认。
  - 源码依据：`packages/core/src/config/plugin/source.ts#parse`（`{ target: input.package, options: input.options ?? {} }`）。
- 包形态（`package.json`）：`type: module`；导出 server 入口（`exports: { "./server": "./src/server.ts" }`，或包根导出）；`files: ["src"]`；`name` 与插件 `id` 对应。宿主按 `server` → 包根 的顺序解析（`packages/plugin/src/host.ts#resolve`）。
- 插件入口：`define({ id, setup })`（`@opencode/plugin/promise`）。

## 3. 架构与模块（分层 + 功能目录）

```
src/
  server.ts        define({id,setup}) 组装；返回 Cleanup
  config.ts        options 解析/默认/校验 → 强类型 Options
  model/           纯逻辑，不 import opencode，可单测
    types.ts       Goal / GoalStatus / 状态结构 / version
    goal.ts        生命周期转换 + 校验（objective 长度、op、已关闭不可重开）
    blocked.ts     blocker_key 归一化 + 连续轮计数
    empty.ts       空转判定（empty_final && !has_activity）
    usage.ts       delta 记账（output+reasoning+cacheWrite，排除 cacheRead）+ 墙钟
    limits.ts      预算命中 → budget-limited
    tool-args.ts   工具 schema/参数校验（纯）
  store/           基于 ctx.storage
    keys.ts        key 构造/解析（goal:<sessionID>）
    repository.ts  get/set/remove/scan（JSON + version 迁移）
    reconcile.ts   启动兜底（scan + ctx.session.get + guard）
  host/            opencode 适配 + 编排
    events.ts      事件归并成本轮事实（session.execution.* 轮边界 / session.step.* 记账 / session.deleted）
    context.ts     session context 钩子：常态轻量提醒 / 续跑注入
    compaction.ts  compaction 钩子：注入目标快照
    plan.ts        agent 检测（受限 agent 拦截）
    queue.ts       单飞串行化（事件/记账/落盘）
    commands.ts    /goal 子命令确定性解析
    register.ts    注册命令 + 工具
    tools.ts       goal 工具执行（调 model）
    continuation.ts 空闲续跑投递
    signals.ts     宿主信号 → 状态（阶段二）
  prompts/         命令模板 / 续跑 / budget-limit / active / compaction
  shared/          纯帮助（id 校验等）
```

数据流：opencode 事件/钩子 → `host` 归并成 facts → `model` 纯函数算新状态与动作 → `store`（KV）落盘 → `host` 执行动作（投递续跑 / 返回工具结果 / 改状态）。

## 4. 命令面

**只有一个命令 `/goal`**（避免与内置冲突；`command_name` 可配）。

- `/goal <text>`：**自适应**——模型先判断信息是否足够（可判定成功标准 / 验证方法 / 范围边界 / 停止条件）：够 → 自动结构化后 `create`；不够 → 访谈（一次一问、≤6 问），问全再 `create`。
- `/goal`（无参）/ `status` / `show`：报告当前目标。
- `/goal pause` / `resume` / `clear`：**在 `execute` 里确定性处理**（不经模型）。
- 实现：`ctx.command.transform(e => e.add({ name, description, execute }))`；`execute({ sessionID, prompt, delivery })` 里判断子命令 → 服务端处理；否则 `ctx.session.prompt(...)` 转发给模型。

## 5. 工具面（单一 `goal` + op）

```ts
goal({
  op: "create" | "get" | "complete" | "resume" | "drop" | "block",
  objective?: string,
  token_budget?: integer,
  blocker_key?: string,   // op=block
  blocker?: string        // op=block
})
```

- 注册：`ctx.tool.transform(e => e.add(tool))`。
- 权限：模型可 `create` / `get` / `complete` / `resume` / `drop` / `block`；`pause` / `clear` **不作为 op**（用户命令）。
- 返回：`{ goal, remainingTokens, completionBudgetReport, blockerStreak? }`（JSON）。
- `create` 仅显式请求；已有未关闭目标时失败并提示（先 `get`/`resume`/`complete`/`clear`）。

## 6. 状态机

`active | paused | blocked | budget-limited | complete`。**不设终态 `unmet`**——放弃由用户 `/goal clear`。（`usage-limited` 阶段二加入。）

| 状态 | 谁设 | 规则 |
| --- | --- | --- |
| `active` | 创建 / resume | — |
| `paused` | 用户命令 / 系统 | `/goal pause` 或中断 |
| `blocked` | **服务端裁决**（模型只报告） | §7 |
| `budget-limited` | 系统 | 记账后 tokens ≥ 预算 |
| `complete` | 模型 | 证据审计通过 |

**冲突优先级**：`budget-limited` > `blocked`（系统事实压倒模型主观）。

## 7. blocked 与空转

**blocked（模型报 + 服务端计数）**
- 模型调 `goal({op:"block", blocker_key, blocker})`。
- 字段：`blockerKey` / `blockerText` / `blockerStreak`，阈值默认 3（可配）。
- 计数（只用 block 调用 + 轮边界）：
  - key 相同 → `streak += 1`；key 不同 → `key=新, streak=1`；
  - 某轮未报 block → `streak=0`；`resume` / 新建目标 → 归零；
  - `streak ≥ 阈值` → **服务端置 blocked**（非终态，可 resume）。
- key 归一化：`trim + lowercase + NFKC + 非字母数字→"-" + 截断`；不做语义匹配。一致性靠把当前 key **回灌**给模型 + 提示词强制复用。
- **收尾**：达阈值时由那次 `op:"block"` 的返回带上"已判定 blocked，停止并总结阻塞/已尝试/需用户提供什么"。

**空转（照抄 Codex，v1）**
- `empty = automatic && empty_final && !has_activity`；`has_activity` = 非空文本 **或** 思考摘要 **或** 提问 **或** 工具调用。
- 连续 **3** 个自动续跑轮 empty → `blocked`（阈值可配）。
- 判据用**消息内容**，**不用 token 数**（token 只用于记账）。

## 8. 续跑与上下文注入

- **触发**：目标 active 且一次执行成功结束（`session.execution.succeeded`）；轮末才续，**不打断**。`session.execution.failed` 只结算、不续跑（避免报错时形成续跑循环）。
- **轮边界/结果**：轮边界 = `session.execution.started → succeeded`；中断 = `session.execution.interrupted`（等价于 `Session.Message.Idle` 的 `outcome: interrupted`）→ **`paused`**（宿主给定，非启发式）。
- **会话恢复**默认不自动续。
- **续跑轮**：注入完整 continuation prompt（XML 转义 objective + 预算 + 完成审计 + blocked 门槛）。
- **常态（普通轮）**：只注入**轻量**提醒（"有 active 目标 → 先 `get_goal`；仅 active 才继续"），**不塞 objective**。
- **compaction**：`ctx.session.hook("compaction", ...)` 注入目标快照（objective/status/预算/checkpoint + "仅 active 才继续"），保证压缩后模型仍知情；压缩后靠常态提醒 + `get_goal` 恢复。
- **超长目标（>4000）**：KV 存全文；续跑时只注入**前 `max_objective_chars` 字 + "（已截断，调 `goal({op:"get"})` 取完整目标）"**；完成审计强制 `get_goal` 复核。

## 9. 宿主信号 → 状态（阶段二）

经 `ctx.session.hook("retry", i => { i.error; i.decision })` 或事件：

| 信号 | 映射 |
| --- | --- |
| 不可重试错误（InvalidRequest/Authentication/ContentPolicy/NoRoute/InvalidProviderOutput/UnknownProvider/Transport/context-overflow） | `blocked` |
| `QuotaExceeded` / Go/FreeUsageLimit | `usage_limited` |
| 可重试（RateLimit/ProviderInternal 5xx） | 忽略（会话继续） |

（v1 仅做 §7 的空转 blocked 与模型报 blocked。）

## 10. 持久化与清理

- **存储**：官方 **`ctx.storage`**（持久 KV，SQLite 后端，按插件 ID 命名空间隔离）。
- **每会话一条记录**：key `goal:<sessionID>`，value 为 JSON：
  - `version`、`goalId`、`objective`（**含 >4000 全文**）、`status`、`tokenBudget`、`tokensUsed`、`timeUsedSeconds`、`blockerKey`、`blockerStreak`、`autoTurns`、`lastContinuationAt`、`updatedAt`。
  - "会话文件 + 目标引用文件"合并为同一条。
- **清理**：`session.deleted` → `storage.remove("goal:<id>")`；`/goal clear` 同。`complete/paused/blocked/budget-limited` 保留。
- **启动 reconcile**：`storage.scan({prefix:"goal:"})` 得本地 ID；用 `ctx.session.get(id)` 判活；不存在且 `updatedAt` 超 `reconcile_guard_minutes`（默认 5）→ remove。查不到/出错一律跳过、不删。只启动跑一次。

## 11. 配置项（`ctx.options`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token_budget` | 无 | 新目标默认 token 预算 |
| `max_goal_token_budget` | 无 | 允许的最大预算 |
| `max_objective_chars` | 4000 | 目标字符上限 |
| `blocked_threshold` | 3 | blocker 连续轮阈值 |
| `empty_threshold` | 3 | 空转连续轮阈值 |
| `reconcile_guard_minutes` | 5 | reconcile 保护窗 |
| `restricted_agents` | `["plan"]` | 受限 agent（Plan 拦截） |
| `command_name` | `goal` | 主命令名 |

`config.ts` 负责解析/默认/校验（host 只传 `Record<string, any>`，不校验）。

## 12. Plan 模式安全

- 读当前 agent：`ctx.session.hook("context", i => i.agent)` 或 `ctx.tool.hook("execute.before", i => i.agent)`。
- 若 agent ∈ `restricted_agents` → **服务端拒绝**：创建目标、自动续跑、resume。
- Plan 的"不能写"由 OpenCode 权限系统负责，我们不重复实现。

## 13. 提示词（英文模板 + 让模型跟随用户语言）

- `command`：`/goal` 模板（规则 + 自适应访谈/结构化 + `$ARGUMENTS` 当不可信数据）。
- `continuation`：续跑（目标/预算/工作从证据/完成审计/blocked 门槛，照抄 Codex 措辞要点）。
- `budget-limit`：预算收尾。
- `active`：常态轻量提醒。
- `compaction`：压缩快照。

## 14. 测试与验收

- `model/` 纯函数单测（状态转换、blocked 计数、空转、记账、校验）。
- `store/` 用内存/mock storage 测 repository + reconcile（含 guard）。
- `host/` 用 mock 钩子/事件测：命令区分、续跑触发、Plan 拦截、compaction 注入。
- **真机 smoke**：opencode2 + 本地确定性模型，跑 `/goal <可验证目标>` → 自动续跑 → 停。
- **验收**：一行配置装好后：`/goal` 自适应建目标；idle 自动续跑；预算/blocked/complete 正确停；`session.deleted` / reconcile 正确清 KV。

## 15. 阶段二

TUI 侧边栏（config-install 方案 B，不用 Solid/JSX）；`usage-limited`；宿主终态错误 → `blocked`；子会话 deferral；i18n；跨会话列表。

## 16. 参考

- `docs/01-design-orientation.md`（决策记录）、`docs/00-comparison.md`
- `docs/codex/README.md`、`docs/omp/README.md`
- `docs/opencode/config-install.md`、`docs/opencode/goal-plugins-landscape.md`
- 宿主源码：`../Externals/opencode`（分支 `v2`；相对本仓库根）

## 17. 修订记录

- **2026-09-25（冒烟修复）**：轮边界由 `session.status`（`busy → idle`）改为 `session.execution.*`。`session.status` / `session.idle` 是 deprecated 定义，虽在客户端 `V2Event` union 里，但**后端从不 emit**（全仓库唯一引用是 `event-manifest.ts` 的注册），因此轮结算与空闲续跑**一次都没执行过**。真实轮边界：`session.execution.started → succeeded`（`failed` 只结算、不续跑），中断仍为 `session.execution.interrupted` → `paused`。教训：**类型在 union 里 ≠ 后端会 emit**；单测 mock 不能替代真实事件流核对。复盘见实现计划文档。
- **2026-09-25（多实例修复）**：promise 版插件的 `ctx.event.subscribe()` 订阅的是**跨所有 location** 的全局事件流（OpenAPI：*"across all server locations"*），而宿主**为每个 location 各加载一份**本插件（官方文档：`ctx.location` 是本实例的 location，不是它收到的事件/会话的 location）⇒ 不处理则同一会话被处理 N 次（实测续跑每轮被注入 3 条）。修复：带 `location` 的事件直接与本实例 `ctx.location.directory` 比较；不带 `location` 的 `session.execution.*` 回落到 `ctx.session.get` 查询会话目录并按会话缓存（**不可**依赖「step.started 先到」的顺序，那会在重载后漏掉第一轮）。细节见 `docs/opencode/plugin-dev-gotchas.md`。
