# opencode-goal 插件设计（v1）

- 日期：2026-09-24
- 状态：已定稿（自审通过，2026-09-24）
- 宿主：**OpenCode V2**（分支 `v2`，`@opencode/plugin@2.0.x`；宿主源码检出 `../Externals/opencode`，相对本仓库根）
- 参考：Codex `ext/goal`、OMP `packages/coding-agent/src/goals`（见 `docs/codex/`、`docs/omp/`）

## 1. 目标与非目标

**目标**：给 OpenCode 加 Codex/OMP 式的持久目标能力——`/goal` 命令 + 单一 `goal` 工具 + 空闲续跑 + 证据式完成 + 阻断/预算护栏，**server 侧插件**、**配置安装一行生效**。

**非目标（v1 不做，阶段二或永不）**：TUI 侧边栏；v1 兼容；`usage-limited`；宿主终态错误自动 `blocked`；子会话 deferral；i18n；遥测；跨会话列表。

> **2026-09-25 更新（v0.2.0）**：`usage-limited`、宿主终态错误 → `blocked`、子会话 deferral、i18n 均已交付（见 `2026-09-25-opencode-goal-v2-host-signals-design.md` / `...-v2-background-deferral-design.md` / `...-v2-i18n-design.md`）；TUI 侧边栏待做；v1 兼容 / 遥测 / 跨会话列表仍不做。

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
    usage.ts       delta 记账（input+output+reasoning+cacheRead+cacheWrite = 真实处理量）+ 墙钟
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

**没有子命令** —— 宿主只有 `name` + 参数文本，没有子命令概念；后台拦截保留名会让用户打错一个字就变成目标文字。所以状态控制是**独立命令**，全部服务端确定性处理、零 token；只有 `/goal <目标>` 会转发给模型。名字跟随 `command_name`（默认 `goal`，派生命令为 `<name>-status` / `-pause` / `-resume` / `-clear`）。另有**调试命令** `/goal-debug`（`debug_command_name` 可配；只读、零 token、**不注入模型上下文**）。

| 命令 | 行为 |
| --- | --- |
| `/goal <目标>` | **自适应**：模型先判断信息是否足够（可判定成功标准 / 验证方法 / 范围边界 / 停止条件）：够 → 自动结构化后 `create`；不够 → 访谈（一次一问、≤6 问），问全再 `create` |
| `/goal`（无参） | 报告当前目标 |
| `/goal-status` | 报告当前目标（服务端） |
| `/goal-pause` | 暂停 active 目标（服务端） |
| `/goal-resume` | 恢复 paused / blocked / budget-limited 目标（服务端） |
| `/goal-clear` | 删除目标记录（服务端） |

- 实现：`ctx.command.transform(e => e.add({ name, description, execute }))`，逐个注册；`/goal <目标>` **用 `synthetic({ text: goalCommandPrompt(...), description: "Goal request · <objective>", resume: true })` 转发给模型**。**不用 `ctx.session.prompt`**：那条会落成 User 消息，整段 prompt 会直接刷满 TUI 转录（见 §8 投递方式）。
- `/goal-debug env | events | sessions | state`：**确定性只读诊断**（本实例 location / 会话归属判定 / 最近事件环 / 全部 goal 记录 / 本会话轮状态），输出走 `synthetic(resume:false)`，不唤醒模型。与业务命令分开，避免调试标记污染正常面。

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
| `paused` | 用户命令 / 系统 | `/goal-pause` 或中断 |
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
- **续跑轮**：**只发一行触发语**（`Continue the active goal from its current state.`）。目标本体与行为规则**不放在消息里**。
- **目标上下文怎么进模型（关键）**：objective + status + 预算 + 全部行为规则（continuation behavior / work from evidence / no-progress check / fidelity / completion audit / blocked audit）由 `ctx.session.hook("context")` 追加到 **system 部分**（`event.system.push(...)`，见 `src/host/hooks.ts`）。system 部分**只存在于当次请求**：不落消息、不进转录、不随轮次堆积历史。目标 active 的每个请求都会带（这也是"目标一直在上下文里"的实现方式）。
- **消息侧投递**：触发语与目标转发都走 `synthetic({ text, description, resume: true })`（不是 `ctx.session.prompt`）。`text` 是给模型的（`to-llm-message` 里 synthetic → `role: "user"`），`description` 是 TUI **唯一显示**的一行（`Goal auto-continue · <objective>` / `Goal request · <目标>`）。**绝不把整段目标上下文塞进消息**——那会刷屏并且每轮都往历史里堆几千字符（我们踩过，见 gotchas §7）。
- **参考实现**：宿主生态里 V2 版 `opencode2-goal-plugin` 就是这么做的——`[Persisted goal] …` 进 system（`ctx.session.hook("context")`），续跑只发一句 `Continue the persisted goal from the latest checkpoint. …`。
- **回执**：`pause`/`resume`/`clear`/`status` 与 `/goal-debug` 走 `synthetic(resume: false)`，且**必须传 `description`**（只给 `text` 时 TUI 那行是空的）。
- **compaction**：`ctx.session.hook("compaction", ...)` 注入目标快照（objective/status/预算 + "仅 active 才继续"），保证压缩后模型仍知情。
- **超长目标（>4000）**：KV 存全文；续跑时只注入**前 `max_objective_chars` 字 + "（已截断，调 `goal({op:"get"})` 取完整目标）"**；完成审计强制 `get_goal` 复核。

## 9. 宿主信号 → 状态（**已交付**，V2 子项目 3）

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
  - `version`、`goalId`、`objective`（**含 >4000 全文**）、`status`、`tokenBudget`、`tokensUsed`、`usage`（分项 `input`/`output`/`reasoning`/`cacheRead`/`cacheWrite`，0.1.1 起；`tokensUsed` = 五项之和）、`timeUsedSeconds`、`blockerKey`、`blockerText`、`blockerStreak`、`emptyStreak`、`lastContinuationAt`、`createdAt`、`updatedAt`。
  - **记账时机**：`step.ended` 只累加进内存，**轮末**（`execution.succeeded`/`failed`）或中断时一次性落账 —— 否则收尾轮（状态翻成 complete/blocked/budget-limited 之后仍在进行的 step）会被漏记。
  - "会话文件 + 目标引用文件"合并为同一条。
- **清理**：`session.deleted` → `storage.remove("goal:<id>")`；`/goal-clear` 同。`complete/paused/blocked/budget-limited` 保留。（**注意**：`session.deleted` 的 payload **不带 `location`**，归属判定必须豁免它，否则事件被判「不属于本实例」丢弃、记录永久残留；见 gotchas §8.2。）
- **启动 reconcile**：`storage.scan({prefix:"goal:"})` 得本地 ID；用 `ctx.session.get(id)` 判活；不存在且 `updatedAt` 超 `reconcile_guard_minutes`（默认 5）→ remove。查不到/出错一律跳过、不删。只启动跑一次。（**实现偏差已修**：判「不存在」必须认 `Schema.TaggedError` 的 `_tag`（`Session.NotFoundError` / `SchemaError`）——插件侧错误**没有** `status`，按 404 判永远不成立；见 `plugin-dev-gotchas.md` §8.1。）

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
| `debug_command_name` | `goal-debug` | 调试命令名（确定性、只读、不注入模型） |
| `debug` | `true` | 注册只读调试工具 `goal_debug`（设 `false` 让模型工具表保持干净） |

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
- **验收**：一行配置装好后：`/goal` 自适应建目标；idle 自动续跑；预算/blocked/complete 正确停。
- **KV 清理的验收（必须真机跑，别只看单测——单测用的假形状曾把两个真 bug 全遮住，见 gotchas §8.3）**：
  1. 造孤儿：建会话 → `/goal` 建目标 → **先触发一次插件重载**（清空实例内存里的会话目录缓存）→ 删会话；
  2. 断言 `/goal-debug sessions` 不再列出它、KV 里该键消失（读 `opencode.db` 的 `kv` 表：**必须把 `-wal` 一起复制**再读，否则 readonly 连接看不到新写入）；
  3. 断言 `/goal-debug events` 里那条 `session.deleted` 的 decision 是 `allow`；
  4. reconcile 兜底：留一条已删会话的记录，重启/重载一次（记录 `updatedAt` 超过 `reconcile_guard_minutes`）后必须消失。

## 15. 阶段二

TUI 侧边栏（config-install 方案 B，不用 Solid/JSX）；`usage-limited`；宿主终态错误 → `blocked`；子会话 deferral；i18n。

- **2026-09-25 状态（v0.2.0）**：`usage-limited` + 宿主终态错误 → `blocked`（V2 子项目 3）、子会话 deferral（V2 子项目 2）、i18n 均**已交付**；TUI 侧边栏**待做**（V2 子项目 5）。

- **跨会话列表：2026-09-25 决定不做。** 理由：① Codex / OMP **均无**此能力（非本取向内功能），唯一来源是第三方 prevalentWare 的 `list_all`；② 聚合需求已由 `/goal-debug sessions`（列出本 location 全部 goal 记录）覆盖；③ per-session 单目标工作流下收益低。若将来确有需求，最小做法是把 `/goal-debug sessions` 提升为正式只读命令（复用 `repository.listAll`，零新逻辑）。

## 16. 参考

- `docs/01-design-orientation.md`（决策记录）、`docs/00-comparison.md`
- `docs/codex/README.md`、`docs/omp/README.md`
- `docs/opencode/config-install.md`、`docs/opencode/goal-plugins-landscape.md`
- 宿主源码：`../Externals/opencode`（分支 `v2`；相对本仓库根）

## 17. 修订记录

- **2026-09-25（冒烟修复）**：轮边界由 `session.status`（`busy → idle`）改为 `session.execution.*`。`session.status` / `session.idle` 是 deprecated 定义，虽在客户端 `V2Event` union 里，但**后端从不 emit**（全仓库唯一引用是 `event-manifest.ts` 的注册），因此轮结算与空闲续跑**一次都没执行过**。真实轮边界：`session.execution.started → succeeded`（`failed` 只结算、不续跑），中断仍为 `session.execution.interrupted` → `paused`。教训：**类型在 union 里 ≠ 后端会 emit**；单测 mock 不能替代真实事件流核对。复盘见实现计划文档。
- **2026-09-25（多实例修复）**：promise 版插件的 `ctx.event.subscribe()` 订阅的是**跨所有 location** 的全局事件流（OpenAPI：*"across all server locations"*），而宿主**为每个 location 各加载一份**本插件（官方文档：`ctx.location` 是本实例的 location，不是它收到的事件/会话的 location）⇒ 不处理则同一会话被处理 N 次（实测续跑每轮被注入 3 条）。修复：带 `location` 的事件直接与本实例 `ctx.location.directory` 比较；不带 `location` 的 `session.execution.*` 回落到 `ctx.session.get` 查询会话目录并按会话缓存（**不可**依赖「step.started 先到」的顺序，那会在重载后漏掉第一轮）。细节见 `docs/opencode/plugin-dev-gotchas.md`。
- **2026-09-25（调试通道）**：新增 `/goal-debug` 命令 + 只读 `goal_debug` 工具（`debug`，**默认开**）+ `events.ts` 里最近 50 条事件的归属判定环。动机：此前排查只能临时改 `goal(op="get")` 的返回值打探针，污染正常工具、且每次都要改码重载。二者定位不同：**命令不注入模型上下文**（源码：`Command.Service` 只出现在 `session/command.ts` 执行、`plugin/host.ts` 插件 API、`plugin/internal.ts` 注册，`session/system-prompt.ts` 无命令清单），只有人/被告知的 agent 可见；**工具会注入**，故 agent 自主诊断必须走工具（description 明写 `DEBUG ONLY / Do not call during normal goal work`）。
- **2026-09-25（投递与显示修复）**：两处问题一并修。①命令回执在 TUI 不可见：`CommandDefinition.execute` 返回 `void`（无返回通道），服务端插件也没有 toast（`ctx.event` 只有 `subscribe`），唯一出口是 `session.synthetic`，而 TUI 只渲染其 **`description`**（`text` 是给模型的）⇒ 只传 `text` 会变成一行空白通知；现所有回执补 `description`。②整段内部 prompt 刷屏：`/goal <目标>` 转发与每轮续跑原先用 `ctx.session.prompt`，会落成 **User 消息**整段显示（用户截图反馈）；现改走 `synthetic({ text, description, resume: true })`——`text` 仍是模型收到的完整内容（`to-llm-message` 里 synthetic → `role: "user"`），`description` 是 TUI 唯一显示的一行摘要（`Goal request · …` / `Goal auto-continue · …`）。宿主自己的 subagent 完成通知就是这么做的。细节见 gotchas §6/§7。
- **2026-09-25（记账口径修正，0.1.1）**：`tokenCost` 由「产出侧」（`output+reasoning+cacheWrite`）改为**真实处理量**（`input+output+reasoning+cacheRead+cacheWrite`）；并修掉**收尾轮漏记**（`step.ended` 只累加内存，轮末 / 中断时一次性落账，`accrue` 不再看状态）。记录新增可选 `usage` 分项；旧记录的 `tokensUsed` 与新口径不可比、不重算。理由：原口径漏掉 cacheRead（长会话里占 ~98%），预算形同虚设；Codex/OMP 排除 cacheRead 属「工作量」口径，与「消耗护栏」目的不符。
- **2026-09-25（上下文注入重构）**：上一版把整段目标上下文（~3000 字符）当**消息**发出去——显示压成了一行，但**历史每轮仍在膨胀**。现改为参考实现的做法（宿主生态的 V2 版 `opencode2-goal-plugin`）：目标本体（objective + status + 预算 + 全部行为规则）由 `ctx.session.hook("context")` 追加到 **system 部分**（只存在于当次请求，不落消息、不进转录）；续跑触发只剩**一行** `Continue the active goal from its current state.`。实测每轮落库从 ~3000 字符降到 **48**，且模型仍跨 5 轮把「1~50 分批」完成（触发语里没有目标 ⇒ 反证 system 注入生效）。**呈现方式的差异**（参考实现驱动用 `session.prompt` → 普通用户消息；我们用 `synthetic` → 通知行）见 gotchas §7。同日发现的 KV 残留问题（`session.deleted` 的 schema 不带 `location` ⇒ 归属回落 `session.get` ⇒ 事件被丢弃；reconcile 又因只认 `status` 而永远探不到「不存在」）**已于同日修复并完成真机验收**：删除事件豁免归属判定 + 判「存在」改认 `_tag`。详见 `docs/opencode/plugin-dev-gotchas.md` §8。
