# oh-my-pi (OMP) Goal Mode —— 设计笔记（源码级）

> 参考实现：`can1357/oh-my-pi` → `packages/coding-agent/src/goals/` + `src/prompts/goals/`（TypeScript）。
> 原始源码归档在 `docs/omp/sources/`。采集日期 2026-09-24。
>
> OMP 是 `badlogic/pi-mono`（Mario Zechner 的 pi）的 fork，33k★，**原生内置 goal 模式**（不是扩展）。

## 1. 结构

```
packages/coding-agent/src/
  goals/
    index.ts          # 出口
    runtime.ts        # GoalRuntime（核心：状态机 + 记账 + 启停）
    state.ts          # 类型：GoalModeState / GoalRuntimeEvent / GoalTokenUsage
    tools/goal-tool.ts# 模型可调用的单一 `goal` 工具
  prompts/
    goals/
      goal-mode-active.md       # 系统侧 goal 上下文（每轮常驻）
      goal-continuation.md      # 隐藏续跑 steer
      goal-budget-limit.md      # 预算耗尽 steer
      goal-mode-context.md      # 组合：goalContext + todoContext
      goal-todo-context.md      # 把持久化 todo 作为"活状态"注入
      guided-goal-interview.md  # /guided-goal 访谈流程
    tools/goal.md               # `goal` 工具描述
```

## 2. 模型工具：单一 `goal` + `op` 枚举

```ts
goalSchema = type({
  op: "'create' | 'get' | 'complete' | 'resume' | 'drop'",
  "objective?": string,
  "token_budget?": number.integer,
})
```

- `strict = true`（强 schema）。
- `create`：无 goal 且无 paused 时创建并**立即启用** goal 模式；要求非空 objective；`token_budget` 可选且必须正整数。
- `get`：返回当前 active/paused goal 与剩余预算。
- `resume`：重新激活 paused goal（`get` 到 paused 必须先 `resume` 才能继续干活）。
- `complete`：**仅当每个交付物都有当前证据**才可；"绝不因为预算低或轮次要结束而 complete"。
- `drop`：丢弃当前 goal（不置为已完成）。
- 返回结构：`{ goal, remainingTokens, completionBudgetReport }`。

> 与 Codex 的差别：OMP 用**单工具多 op**；Codex 用三个独立工具。OMP 没有 `blocked` 状态（用 pause 表达），也**没有**把 `complete` 之外的终态交给用户/系统之外的角色。

## 3. 状态与类型（`state.ts`）

```ts
interface GoalModeState { enabled: boolean; mode: "active" | "exiting"; reason?: "completed"; goal: Goal }
type GoalRuntimeEvent =
  | { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
  | { type: "goal_continuation_requested"; prompt: string }
```

`Goal.status`（来自 `@oh-my-pi/pi-tui/tools/goal`）：`active | paused | budget-limited | complete | dropped`。

## 4. 运行时（`runtime.ts`）—— 自研最该对照的部分

### 4.1 宿主接口（依赖注入，便于测试）
`GoalRuntimeHost`：`getState/setState`、`getCurrentUsage`、`emit`、`persist("goal"|"goal_paused"|"none")`、`sendHiddenMessage({customType, content, deliverAs})`、`now?`。

### 4.2 记账（最有参考价值）
- **turn 快照**：`onTurnStart(turnId, baselineUsage)` 记录基线；结束时用 delta。
- **token delta**（`goalTokenDelta`）：
  `max(0, input-base) + max(0, cacheWrite-base) + max(0, output-base)`。
  注释明确解释了**为什么和 codex-rs 不同**：Pi 在 Anthropic/Bedrock 上单独收到 `cacheWrite`（旋转 1h 缓存或重锚系统提示可能写入 10 万+ token，必须计入预算）；`cacheRead` 是复用前缀，**不计**。
- **墙钟时间**：`#wallClock.lastAccountedAt` + `activeGoalId`，按秒累加。
- **串行化**：`#accountingTail: Promise<void>` 形成一条 promise 链（`#withAccounting`），保证记账不并发打架。
- **触发点**：
  - `onToolCompleted(toolName)`：非 `goal` 工具成功 → `flushUsage("allowed")`（允许在预算翻转时发 steer）。
  - `onGoalToolCompleted()`：goal 工具自己完成 → `flushUsage("suppressed")`。
  - `onAgentEnd()`：轮次结束 → `flushUsage("suppressed")`。
- **持久化节流**：正常工具 flush 只更新内存/UI；只在 `tokenDelta>0`、翻转 budget-limited、或"内部会话切换前"（`persistWallClock`）才真正落盘 —— 避免每次工具事件都写一份完整 objective 快照。

### 4.3 预算与暂停
- 记账后若 `tokensUsed >= tokenBudget` 且 `status==="active"` → 翻 `budget-limited`，并**每个 goal 只发一次**隐藏预算 steer（`#budgetReportedFor` 幂等）。
- `onTaskAborted({reason})`：`reason==="interrupted"`（用户中断）→ 把 goal 置 `paused` 并停用；`internal` 只做记账。
- `onThreadResumed({preserveActiveGoal})`：除非要求保留，否则 active goal 在会话恢复时**转为 paused**（不静默续跑）。
- `pauseGoal` / `resumeGoal` / `dropGoal` / `completeGoalFromTool` / `createGoal` / `replaceGoal`：全部经 `#withAccounting`，并在变更前 `flushUsageLocked("suppressed")`。

### 4.4 续跑
- 隐藏消息 `customType: "goal-budget-limit"`，`deliverAs: "steer"`。
- 续跑 prompt 由 `buildContinuationPrompt()` 生成（仅 active 时）。

## 5. 提示词（`prompts/goals/`）

### `goal-mode-active.md`（每轮常驻的 goal 上下文）
`<goal_context>` 包裹；objective 转义；Budget 四行；只列 `goal({op:"get"})` 与 `goal({op:"complete"})` 两个用法；强调"保持完整目标、不许重定义为更小子集"、"预算耗尽 ≠ 完成"。

### `goal-continuation.md`（隐藏续跑 steer）
极简但硬核，6 条审计：
1. Objective → 具体交付物（文件/行为/测试/门禁/产物）。
2. 每个交付物 → 权威证据（文件内容、命令输出、测试、PR/issue 状态）。
3. 检查**当前实际状态**（读文件、跑命令），**绝不信旧会话记忆**。
4. 验证范围 = 主张范围（一个文件的单测不证明端到端功能）。
5. 不确定 = 未达成（间接证据/部分覆盖/缺失产物/"看着对"都算没完成）。
6. **预算耗尽 ≠ 完成**；预算紧就保持 active、停止本轮。
结尾一句："Unfinished: keep working. NEVER narrate continuation — execute."（别光叙述，去干）。

### `goal-budget-limit.md`
系统已标 budget-limited：不要开始新实质工作，收尾并给下一步。

### `goal-todo-context.md`（很聪明的一招）
把**持久化 todo 列表**当作"活状态"注入：续跑轮没有可见的用户催促，用 todo 代替；干活前先比对 todo，有过期/已完成项先调 `todo` 修正，别让 `in_progress` 悬着。

### `guided-goal-interview.md`（`/guided-goal`）
先访谈再建目标，一次只问一个问题，最多 ~6 问。目标必须钉死 5 要素：
1. **可判定成功标准**（测试通过、命令退出 0、分数 ≥N、文件存在…；拒绝"works well/干净/完成"）。
2. **验证方法**（具体命令）。
3. **尝试上限**（明确最多几轮/几次；必要时 token 预算）。
4. **范围边界**（允许的文件/目录/操作；明确不动的 denylist）。
5. **停止/升级条件**（歧义、危险操作、达到上限时停下来交给人）。
产出固定 markdown 结构：`## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions`。

## 6. 对自研的启示（OMP 独有）

1. **单 `goal` 工具 + `op`** 比多工具更省 context、更易 strict 校验。
2. **token 记账要含 cacheWrite、排除 cacheRead**（面向 Anthropic 系时尤其重要）—— 这是 Codex 没覆盖的现实差异。
3. **记账串行化**（promise 链 / 信号量）是必须的。
4. **落盘节流**：只在大 delta、状态翻转、会话切换前写盘，避免快照膨胀。
5. **把 todo 当活状态注入**，弥补自动续跑缺少用户反馈的问题。
6. **交互式目标访谈（5 要素）** → 从源头保证目标可验证，是"目标质量"的关键。
7. 中断 → 暂停；会话恢复默认不自动续跑（需显式 resume）。
8. 提示词可以短，但"完成审计 6 条 + 不许重定义成功 + 预算≠完成"必须有。
