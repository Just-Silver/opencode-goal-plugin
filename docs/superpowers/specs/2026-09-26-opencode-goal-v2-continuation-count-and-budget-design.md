# opencode-goal V2 子项目 6 设计：自动续跑计数 + 预算随时可调

- 日期：2026-09-26
- 状态：**待实现**（本文件为规格）
- 宿主：**OpenCode V2**（`@opencode/plugin@2.0.16`；宿主源码检出 `../Externals/opencode`）
- 上级：V2 里程碑。子项目 5（TUI 侧边栏）仍待做；本子项目**独立**（不依赖它）。
- 相关：`docs/superpowers/specs/2026-09-24-opencode-goal-design.md`（v1 §3 数据模型 / §4 状态机 / §5 工具）、`docs/superpowers/specs/2026-09-25-opencode-goal-v2-i18n-design.md`（文案约定）、`docs/opencode/known-issues.md`、`docs/opencode/plugin-dev-gotchas.md`

## 1. 背景与问题

两个缺口：

1. **自动续跑没有次数统计。** `Goal` 只记 `lastContinuationAt`（最近一次续跑时间戳，`continuation.ts` 写入），无法回答「这个目标自动续跑了多少轮」。用户需要这个数字来判断进度与成本；它也能顺带暴露宿主「幽灵激活 → 续跑 N 倍」的问题（`known-issues.md` 第 2 条）。
2. **预算只能在创建目标时设定。** `tokenBudget` 的**唯一**写入口是 `goal(op="create")`（`tools.ts`）；`applyBudget`（`model/limits.ts`）只做**单向**降级（active / blocked / usage-limited → budget-limited）。目标一旦 `budget-limited`，用户除了 `/goal-clear` 重建（丢失记账）或直接改 KV，**没有正常途径**提高额度继续。参考实现 OMP 用 `onBudgetMutated`（`goals/runtime.ts`）补上了这个缺口，本子项目照此对齐。

### 1.1 命令与工具的分工（沿用既有不变式）

v1 定下且当前代码遵守的不变式是：**命令面全部零 token、零歧义；只有 `/goal <目标>` 会转发给模型**（`commands.ts` 注释）。本子项目**保持**该不变式：

- 预算的确定性修改 → 独立命令 `${command_name}-budget`（默认 `/goal-budget`）。
- 模型侧只加一个 `goal(op="budget")`，供用户在对话里**明确要求**时由模型代劳（与 `resume` 同级，属「状态变更」而非「新工作」）。

## 2. 目标与非目标

**目标**：

- 新增 `Goal.continuations`（自动续跑**累计**次数；目标生命周期内累计，`resume` / 暂停 / 各种停下都**不**重置），在投递续跑轮时 +1。
- 把次数展示在：`/goal-status`、自动续跑回执（`#N`）、`goal` 工具返回、`/goal-debug state`。
- 新增预算写入口：
  - 命令 `/goal-budget <正整数 | none>`（零 token、确定性）。
  - 工具 `goal(op="budget", token_budget=<非负整数>)`（`0` = 无预算）。
- 预算修改语义：改大且原本 `budget-limited` → **自动恢复 active**；改成 `0`/`none` → 清空预算（不限）；改小到低于已用量 → 立即 `budget-limited`。
- 约束边界：`max_goal_token_budget` 只约束**数值预算**（`budget > max` → 拒绝）；`none` 表示无上限、**有意不受该上限约束**（需求 5）。运营方若要求「预算不可取消」，需另加开关（本子项目不做，见 §8）。

**非目标（本子项目不做）**：

- 不改**状态机其余部分**（`active` / `paused` / `blocked` / `usage-limited` / `complete` 的既有转移与优先级）。
- 不为续跑次数设**上限/自动停止**（本子项目只统计；「续跑上限」留作后续子项目，`continuations` 已为其留好数据）。
- **不**把次数注入每轮 system 上下文（`goalContext` / `compactionSnapshot` / `budgetLines`）——避免改动模型提示词；模型需要时用 `goal(op="get")` 读 `GoalView.continuations`。
- 不改 `/goal-resume` 的语义（仍只改状态，不主动唤醒模型）。
- 不记录「谁在何时改了预算」的审计字段（不新增 `budgetUpdatedAt`）。
- 不改配置项（`token_budget` / `max_goal_token_budget` 的语义与默认值不变）。
- 旧记录**不补算**已发生的续跑次数（计数自本版本起）。

## 3. 设计

### 3.1 数据模型

`src/model/types.ts`：

```ts
export interface Goal {
  // ...既有字段
  /** 自动续跑累计次数；旧记录（本版本前）没有 → 读取时按 0 处理。 */
  readonly continuations?: number
}
```

- **可选**字段：旧 KV 记录缺省即按 0 处理，`decodeGoal` 无需迁移，也不会因缺字段把整条记录判死（沿用 `usage?` / `lastContinuationAt?` 的先例；`tokenBudget?` 同理）。
- 读取处一律 `goal.continuations ?? 0`；`GoalView.continuations` 为必填 `number`（缺省 0）。

### 3.2 计数的写入点

`src/model/goal.ts` 新增纯函数：

```ts
/** 落账一次自动续跑：计数 +1，并刷新 lastContinuationAt / updatedAt。 */
export function recordContinuation(goal: Goal, now: number): Goal {
  return { ...goal, continuations: (goal.continuations ?? 0) + 1, lastContinuationAt: now, updatedAt: now }
}
```

`src/host/continuation.ts` 的 `onIdle`（全仓**唯一**的续跑投递点）：

```ts
const count = (goal.continuations ?? 0) + 1
await port.deliver({
  sessionID,
  text: continuationTrigger(),
  description: noticeLine(format(deps.messages["label.autoContinue"], { count }), goal.objective),
})
const now = deps.now()
await deps.repo.save(sessionID, recordContinuation(goal, now))
```

- **口径 = 目标生命周期累计**：`create` 起 0；每次投递 +1；`/goal-pause`、`/goal-resume`、阻断 / 受限 / 预算停下都**不**重置；`drop` + `create`（换目标）自然归 0。
- **投递即计数**（与 `lastContinuationAt` 同一处、同一次写库），不依赖后续轮是否成功——保证「投递了几轮」与「宿主 / 模型是否跑挂」无关。
- 已知宿主幽灵激活会 N 倍投递 → 计数随之 N 倍增长，这正是有用的诊断信号（smoke `continuation` 场景本就断言 `cont <= succeeded`）。

### 3.3 预算修改（model 层）

`src/model/limits.ts` 新增 `setBudget`（与 `applyBudget` 同属预算模块）：

```ts
export interface BudgetChange {
  /** 新预算；undefined = 无预算（清空）。 */
  readonly budget: number | undefined
  readonly maxTokenBudget?: number
  readonly now: number
}

export function setBudget(goal: Goal, change: BudgetChange): Goal
```

**算法（权威）**：

1. 校验 `budget`：非 `undefined` 时必须为正整数，否则 `throw new GoalError("invalid-budget", ...)`。
2. 校验上限：`budget !== undefined && maxTokenBudget !== undefined && budget > maxTokenBudget` → `throw new GoalError("budget-exceeds-max", ...)`（复用 `createGoal` 的错误码与消息形状）。
3. 写字段（**唯一写法**）：解构剔除旧键后按情况写回，确保清空时 `tokenBudget` **键真正不存在**（`"tokenBudget" in next === false`）。注意：`{ ...goal, tokenBudget: undefined }` 会留下显式键、**不满足**要求；**不能**照抄 `createGoal` 的条件展开——它从零构造可「不产生」键，而 `setBudget` 是在已有对象上覆盖，条件展开无法移除已存在的键（会导致 `/goal-budget none` 静默失败、旧额度残留）。

   ```ts
   const { tokenBudget: _previous, ...rest } = goal
   const next: Goal =
     budget === undefined
       ? { ...rest, updatedAt: now }
       : { ...rest, tokenBudget: budget, updatedAt: now }
   ```
4. **超限降级**：`next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget` → `return applyBudget(next, now)`（active / blocked / usage-limited → budget-limited；paused / complete / budget-limited 原样）。
5. **解除预算限制**：`next.status === "budget-limited"` → `return resume(next, now)`（回 `active`，并清 blocker 审计与 `lastError`——「恢复即新一轮」，与 `/goal-resume` 同语义）。仅当第 4 步未 return（即新额度够用）时才可能到达。
6. 其它情形（active 且够用 / paused / blocked / usage-limited / complete）→ 原样返回 `next`（只改额度，不动状态）。

`GoalErrorCode` 增加 `"invalid-budget"`（`model/goal.ts`）。

**与 `events.ts` 的关系**：事件路由的 `save()` 每次落库都会追一次 `applyBudget`；`setBudget` 自带同款降级，所以命令 / 工具直接 `repo.save` 即可，**不依赖**事件层。

### 3.4 入口 A：命令 `${command_name}-budget`

- 注册名：`${command_name}-budget`（默认 `/goal-budget`），与 `-status` / `-pause` / `-resume` / `-clear` 同族；描述走 `messages["cmd.budget"]`。
- 参数解析（`commands.ts`）：
  - 空参 → `notice.budgetUsage`（不报状态，避免与 `/goal-status` 混淆）。
  - `none` / `off` / `0`（大小写不敏感，先 trim）→ 清空预算。
  - `/^[1-9]\d*$/` → 正整数预算。
  - 其它 → `notice.budgetInvalid`（`{value}` = 原样 trim 的输入）。
- 无目标 → `notice.noGoal`。
- `setBudget` 放在 `try/catch`，捕获**任意 `GoalError` 并按 `code` 分派**（不写死单个 code，避免后续放宽解析后漏兜）：`budget-exceeds-max` → `notice.budgetExceedsMax`（`{budget, max}`，`max = options.maxGoalTokenBudget`）；其余（含 `invalid-budget`）→ `notice.budgetInvalid`。
- 成功 → `notice.budgetSet`（`{budget, status}`）或 `notice.budgetCleared`（`{status}`）；`status` 走 `statusLabel(messages, goal.status)`（否则中文回执会出现「active」）。
- `GoalCommandHandlers` 新增 `budget: (sessionID: string, text: string) => Promise<void>`。**注意**：本命令需要参数文本，签名比其它四个多一个入参；`server.ts` 传 `input.prompt.text`。

**不主动唤醒模型**：命令仍是零 token 的状态变更（与 `/goal-resume` 一致）。目标若因此回到 `active`，会在**下一次轮边界**（用户下一条消息结束 / 任何一次 drain）照常续跑；命令本身不投递续跑轮（取舍见 §8）。

### 3.5 入口 B：`goal(op="budget")`

- `ToolOp` / `OPS`（`model/tool-args.ts`）增加 `"budget"`；工具 schema 的 `op` 枚举同步。
- `parseToolArgs` 的 `token_budget`：由「正整数」放宽为「**非负整数**」（负数、非整数仍拒绝）；`0` 保留为 0。**同步改校验错误消息**（`model/tool-args.ts`）：`must be a positive integer` → `must be a non-negative integer (0 = no budget)`。
- `host/tools.ts` 新增分支：

  ```
  case "budget":
    restricted agent                              → throw "goal: this agent cannot change the budget"
    !existing                                     → throw "goal: no goal to change the budget of"
    args.tokenBudget === undefined                → throw "goal: token_budget is required for op budget (0 = no budget)"
    goal = setBudget(existing, {
      budget: args.tokenBudget === 0 ? undefined : args.tokenBudget,
      maxTokenBudget: options.maxGoalTokenBudget,
      now,
    })
    save → view
    status === "budget-limited" → 附 budgetLimitPrompt（与 block 分支同款收尾指令）
  ```

  `setBudget` 抛出的 `GoalError` 收敛为 `Error("goal: " + message)`（沿用工具错误前缀）。
- `op="create"` 的 `token_budget: 0` 同样解释为「无预算」：`tokenBudget: args.tokenBudget === 0 ? undefined : (args.tokenBudget ?? options.tokenBudget)`。
- 工具 schema（`goalToolInput`）：`token_budget` 由 `minimum: 1` 改为 `minimum: 0`，描述写明「0 = 无预算」。

**模型自扩展防护**：`prompts/index.ts` 的 `budgetLimitPrompt` 追加一行——`Do not call goal with op "budget" unless the user explicitly asked for a new budget.`；`goalCommandPrompt` 的措辞同步为「除非用户明确给出，否则不要设置或修改预算」。`goalContext` 的「Every state change goes through the goal tool (…)」列表补上 `"budget"`。

### 3.6 展示

| 出口 | 变化 |
| --- | --- |
| `/goal-status`（`commands.ts` 的 `statusLine`） | `status.line` 末尾（`. 目标：` 前）插入 `{continuations}`，值来自 `status.continuations`（`count = goal.continuations ?? 0`） |
| 自动续跑回执（`continuation.ts`） | 标签带序号：`label.autoContinue` = `目标自动续跑 #{count}`（`count` 为本轮序号，即 +1 之后的值） |
| `goal` 工具返回（`model/tool-result.ts` 的 `buildToolResult`） | `GoalView` 新增 `continuations: number`（缺省 0） |
| `/goal-debug state`（`host/debug.ts`） | `debug.state.goal` 的值追加 `continuations=N` |

**不注入模型上下文**：`goalContext` / `compactionSnapshot` / `budgetLines` 不含续跑次数（保持提示词稳定）；模型如需可用 `goal(op="get")` 读到 `GoalView.continuations`。自动续跑回执仍按现有 72 字上限裁剪目标正文（只改标签）。

### 3.7 文案清单（i18n，权威）

三个文件必须同步：`src/i18n/messages.ts` 的 `Messages` 接口（新键必须在此声明，否则 `deps.messages["notice.budgetSet"]` 之类的取键编译不过，且 `satisfies` 会对 en/zh 对象字面量的多余属性报错）、`en.ts`、`zh-CN.ts`（`satisfies Messages`，漏键 `tsc` 报错）。新增 / 修改：

| Key | en | zh-CN |
| --- | --- | --- |
| `cmd.budget`（新） | Set the token budget for the current goal (a positive integer, or "none"/0 to remove it). | 设置当前目标的 token 预算（正整数，或「none」/0 取消预算）。 |
| `notice.budgetSet`（新） | Budget set to {budget}; goal is now {status}. | 预算已设为 {budget}；目标当前为「{status}」。 |
| `notice.budgetCleared`（新） | Budget removed (unlimited); goal is now {status}. | 已取消预算（不限）；目标当前为「{status}」。 |
| `notice.budgetUsage`（新） | Usage: a positive integer, or "none" to remove the budget. | 用法：正整数，或「none」取消预算。 |
| `notice.budgetInvalid`（新） | Invalid budget "{value}": use a positive integer, or "none" to remove it. | 无效的预算「{value}」：请用正整数，或「none」取消预算。 |
| `notice.budgetExceedsMax`（新） | Budget {budget} exceeds max_goal_token_budget {max}. | 预算 {budget} 超过 max_goal_token_budget {max}。 |
| `status.continuations`（新） | ; auto-continues {count} | ；自动续跑 {count} 次 |
| `status.line`（改） | Goal ({status}) — tokens {tokens} / {budget}{detail}; {seconds}s{lastError}{continuations}. Objective: {objective} | 目标（{status}）— tokens {tokens} / {budget}{detail}；{seconds}s{lastError}{continuations}。目标：{objective} |
| `label.autoContinue`（改） | Goal auto-continue #{count} | 目标自动续跑 #{count} |
| `tool.goal.description`（改） | 'Manage the persistent goal for this session. op "create" starts a goal only when explicitly requested; "get" reports it; "complete" asserts evidence-backed completion; "resume"/"drop" are also available; "block" reports a recurring blocker; "budget" changes the token budget (only when the user explicitly asks).' | '管理本会话的持久目标。op "create" 仅在用户明确要求时启动目标；"get" 报告目标；"complete" 在证据充分时声明完成；另有 "resume"/"drop"；"block" 上报反复出现的阻碍；"budget" 修改 token 预算（仅在用户明确要求时）。' |
| `tool.goal.op`（改） | Operation: create \| get \| complete \| resume \| drop \| block \| budget. | 操作：create \| get \| complete \| resume \| drop \| block \| budget。 |
| `tool.goal.tokenBudget`（改） | Token budget for op "create"/"budget" (positive integer; 0 = no budget). | token 预算（op "create"/"budget" 时使用；正整数，0 表示无预算）。 |

> **不本地化（不变）**：`prompts/index.ts` 的提示词、工具错误信息、`completionBudgetReport`、配置校验错误、`console.error` 日志。

### 3.8 接线与数据流

- `GoalDeps` **不新增**字段（`recordContinuation` / `setBudget` 是纯函数；命令 / 工具已有 `repo` / `options` / `now` / `messages`）。
- `server.ts`：在 `-clear` 之后注册 `${name}-budget`（`execute: (input) => handlers.budget(input.sessionID, input.prompt.text)`）。
- 数据流：
  - `onIdle` → `recordContinuation` → KV（续跑计数）；
  - `/goal-budget` → `setBudget` → KV；
  - `goal(op="budget")` → `setBudget` → KV；
  - 状态转换（降级 / 解除）由 `setBudget` 内的 `applyBudget` / `resume` 决定。

## 4. 与现有机制的关系

- **状态机**：只新增「预算变更」这一条输入；既有优先级（`budget-limited` > `blocked`）不变；`setBudget` 复用 `applyBudget` / `resume`，不自造转移。
- **事件路由**：不改 `events.ts`；`setBudget` 自带 `applyBudget`，与 `save()` 行为一致。
- **记账**：不改（token 记账与续跑计数是两回事，互不影响）。
- **i18n**：新增 7 键、修改 5 键；`messages.test.ts` 的键集合 / 占位符对齐 / 无残留渲染测试自动覆盖。
- **命令零 token 不变式**：保持（只有 `/goal` 转发模型）。
- **热重载**：与本子项目无关；实现期改 `src/**` 的注意事项同前（见 §7）。

## 5. 边界与状态机（真值表）

| 变更前状态 | 新额度 vs 已用量 | 结果 |
| --- | --- | --- |
| active | 够用 / 清空 | active（仅改额度） |
| active | 不够用 | budget-limited |
| budget-limited | 不够用 | budget-limited（`applyBudget` 幂等 no-op） |
| budget-limited | 够用 / 清空 | **active**（resume 语义：清 `blockerKey` / `blockerText` / `blockerStreak` / `emptyStreak` / `lastError`） |
| blocked | 不够用 | budget-limited |
| blocked | 够用 / 清空 | blocked（不动） |
| usage-limited | 不够用 | budget-limited |
| usage-limited | 够用 / 清空 | usage-limited（不动） |
| paused | 任意 | paused（不动） |
| complete | 任意 | complete（不动；仅写额度，无实际意义） |

校验失败：非正整数 → `invalid-budget`；超 `max_goal_token_budget` → `budget-exceeds-max`（命令 / 工具各自转成用户文案 / 工具错误，**KV 不变**）。

**判定用量口径**：`setBudget` 的「够用 / 不够用」以**已落账**的 `tokensUsed`（KV 值）为准。轮内尚未落账的用量（`events.ts` 的轮内累积器）不计入；若本轮已产生大量 token，`op="budget"` 改小后可能当次不翻 `budget-limited`，由轮末 `save()` 里的 `applyBudget` 兜底——与既有 `block` 分支（`tools.ts` 对 `existing` 调 `applyBudget`）同款口径，**非回归**。展示仍用 `withPending` 叠出实时值。

## 6. 测试与验收

**model 层**：

- `goal.test.ts`：`recordContinuation`（`undefined`→1、0→1、3→4；`lastContinuationAt` / `updatedAt` 刷新）。
- `limits.test.ts`：`setBudget` 按下表逐行验证；`invalid-budget` / `budget-exceeds-max` 抛错；`budget: undefined` 真正清除字段（`"tokenBudget" in goal === false`）；`budget-limited` + 够用 → active 且清 streak / lastError。
- `tool-args.test.ts`：`token_budget: 0` 通过（保留 0）；负数 / 小数仍拒绝；`op: "budget"` 通过。
- `tool-result.test.ts`：`GoalView.continuations` 缺省 0。

**host 层**：

- `continuation.test.ts`：投递把 `continuations` +1 并落库；回执 description 含 `#{n}`；无目标 / 受限 agent 不计数。
- `commands.test.ts`：`/goal-budget` 各分支（空参 / `none` / `0` / 正整数 / 非法 / 无目标 / 超上限）；`statusLine` 含续跑次数；status 行随语言。
- `tools.test.ts`：`op="budget"` 设置 / 清空 / 缺参报错 / 受限 agent / 超上限；`op="create"` + `token_budget: 0` → 无预算；改小到低于已用 → 返回带 `budgetLimitPrompt`。
- `debug.test.ts`：state 行含 `continuations=N`。
- `server.test.ts`：`/goal-budget` 已注册；**同时更新 `:108` 的精确命令数组断言**（在 `goal-clear` 与 `goal-debug` 之间插入 `goal-budget`）。该测试走 `setup`，用 `options: { language: "en" }` 固定语言。

**i18n**：`messages.test.ts` 自动覆盖新键（键对齐 / 占位符对齐 / 无残留 / 双语不雷同）。

**验收**：`bun test` 全绿 + `bunx tsc --noEmit` 无错。

**真机（可选，建议）**：

1. `/goal-status` 回执出现「自动续跑 N 次」。
2. 目标跨轮续跑时，notice 显示「目标自动续跑 #1」「#2」…
3. `token_budget=1` 冒烟目标 → budget-limited → `/goal-budget 500000` → 状态回 active、回执「预算已设为 500000；目标当前为「进行中」。」→ 再发一条消息后继续续跑。
4. `/goal-budget none` → 回执「已取消预算（不限）；…」。
5. 对话式：「预算加到 50 万，继续」→ 模型调用 `goal(op="budget", token_budget=500000)`。
6. `bun scripts/smoke-api.mjs --session <sid> --scenario budget` 仍 PASS；`continuation` 场景比值仍 ≈ 1。

**发布**：本子项目为**新功能** → minor（下一版 `0.3.0`）；`CHANGELOG.md` 的 `[Unreleased] → Added`。文档同步：`README.md` 用法表加 `/goal-budget <n>`、`docs/README.md` 索引加本 spec、`docs/opencode/smoke-checklist.md` 补一条「预算改额 / 续跑计数」记录。

## 7. 实施注意

- 改 `src/**` 会触发宿主热重载：实现期间先把插件从 `~/.config/opencode/opencode.json` 临时移除（或按当前 npm 安装方式，全部改完 `opencode plugin update` + `opencode reload`）。
- `parseToolArgs` 放宽 `token_budget` 会改变既有断言：`tool-args.test.ts` 的「rejects a non-positive token_budget」需改为「rejects a negative token_budget」，并同步改校验错误消息（§3.5）。
- **`server.test.ts:108` 的精确命令数组断言**会红：需插入 `"goal-budget"`（§6 已列，实施计划勿漏）。
- `label.autoContinue` 由「无占位符」变为含 `{count}`：检查所有使用点（当前仅 `continuation.ts`），并补 `format` 导入。
- `status.line` 增加 `{continuations}`：`commands.ts` 的 `statusLine` 必须传该参数，否则残留占位符（`messages.test.ts` 的组合模板渲染测试会拦下）。
- `tool-result.test.ts` **没有** `goal` 整对象断言（只对 `.goal.usage` / `.goal.lastError` 等字段 `toEqual`），新增 `continuations` 字段**不会**破坏既有用例，只需新增一条「缺省 0」的用例。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 模型在预算用尽时自行加预算、无限续跑 | `budgetLimitPrompt` 明令禁止（非用户明确要求不得调用）；`max_goal_token_budget` 仍是数值预算的硬上限（`none` 除外，见 §2）；工具描述限定「仅用户明确要求」 |
| 旧记录无 `continuations` → 展示不一致 | 字段可选 + 读取 `?? 0`；文档声明「计数自本版本起」 |
| `/goal-budget` 改完不立即续跑，用户以为「没生效」 | 回执带**变更后状态**（「目标当前为『进行中』」）；README / 文档说明「与 `/goal-resume` 一致，下一轮边界继续」；若确需「加钱即续跑」，另立子项目统一处理 `/goal-resume` 与 `/goal-budget` |
| `token_budget: 0` 被误解为「预算为 0（立即受限）」 | schema / 工具描述 / 命令文案三处都写明「0 = 无预算」；`create` 与 `budget` 行为一致 |
| 改小到低于已用量却期望「保持 active」 | 真值表 + 测试固定：立即 budget-limited（系统事实压倒主观） |
| 计数与宿主幽灵激活耦合（N 倍） | 属**预期**诊断信号，不计为回归（smoke 已断言 `cont <= succeeded`） |
| 命令名可配置（`command_name`）但文案里不出现命令名 | 新文案不含命令名（避免硬编码 `/goal-budget`）；既有 `signal.*` 的 `/goal-resume` 硬编码属历史遗留，不在本子项目扩大 |
| `none` 让 `max_goal_token_budget`（运营方硬上限）形同虚设：用户或模型可解除预算 | 需求 5 的**有意取舍**，§2「约束边界」已写明「上限只约束数值预算，不约束 none」。若确需「预算不可取消」，另立配置开关子项目 |
| 轮内改小预算时判定用已落账用量，可能当次不翻 `budget-limited` | §5「判定用量口径」已写明由轮末 `applyBudget` 兜底；与既有 `block` 分支同款口径，非回归 |

## 9. 参考

- 参考实现 OMP：`docs/omp/sources/packages/coding-agent/src/goals/runtime.ts` 的 `onBudgetMutated`（改预算 → 超限降级 / 解除预算限制回 active）；`state.ts`（`Goal` 形状）；`tools/goal-tool.ts`（工具未暴露预算变更，由 TUI 侧调用）。
- Codex：`docs/codex/sources/codex-rs/ext/goal/templates/goals/objective_updated.md`、`budget_limit.md`。
- 本仓库：`src/model/{types,goal,limits,usage,tool-args,tool-result}.ts`、`src/host/{continuation,commands,tools,debug}.ts`、`src/server.ts`、`src/config.ts`、`src/i18n/*`、`src/prompts/index.ts`。

## 10. 修订记录

- **2026-09-26（初稿）**：确定续跑计数口径（生命周期累计，`resume` 不重置）与展示位（status / 续跑回执 / 工具返回 / debug）；确定预算双入口（命令 + 工具 op）、改大自动回 active、支持 `none`/`0` 清空预算；保持「命令零 token」不变式，明确 `setBudget` 复用 `applyBudget` / `resume` 的算法与真值表。
- **2026-09-26（独立子代理审阅后修订）**：① §3.3 第 3 步改为唯一实现（解构剔除旧键后再写回）——原稿「删键」与「`{ ...goal, tokenBudget: budget }`」自相矛盾，且照抄 `createGoal` 的条件展开无法移除已存在的键，会让 `/goal-budget none` 静默失败（Blocker）；② §3.4 命令 `catch` 改为按 `GoalError.code` 分派（不再只兜 `budget-exceeds-max`）；③ §3.7 明写新键必须同步加进 `messages.ts` 的 `Messages` 接口（Major）；④ §3.5/§7 补 `parseToolArgs` 校验错误消息随「非负整数」同步改；⑤ §6/§7 补 `server.test.ts:108` 精确命令数组断言这个必改点（Major）；⑥ §5/§8 写明预算判定用「已落账用量」、轮末 `applyBudget` 兜底（与 `block` 同款，非回归）；⑦ §2/§8 写明 `max_goal_token_budget` 只约束数值预算、不约束 `none`；⑧ §7 更正 `tool-result.test.ts` 的影响评估（无 `goal` 整对象断言，不会破坏既有用例）。
