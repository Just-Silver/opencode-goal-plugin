# 自动续跑计数 + 预算随时可调 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 opencode-goal 插件加上「自动续跑累计计数」与「目标运行期随时改 token 预算（含清空为不限）」两个能力。

**Architecture:** model 层加两个纯函数——`recordContinuation`（计数落账）与 `setBudget`（改预算 + 复用既有 `applyBudget` / `resume` 做状态转移）；host 层把 `setBudget` 接到新命令 `/goal-budget` 与 `goal(op="budget")`，把 `recordContinuation` 接到唯一的续跑投递点；展示面（status / 续跑回执 / 工具返回 / debug）补上计数。零新增运行时依赖、命令面保持零 token。

**Tech Stack:** TypeScript ESM（bun 直接加载 `.ts`，无构建）、bun test、`bunx tsc --noEmit`、宿主 `@opencode/plugin`（仅 `import type`）。

**Spec:** `docs/superpowers/specs/2026-09-26-opencode-goal-v2-continuation-count-and-budget-design.md`

## Global Constraints

- 单包、**零运行时依赖**：`dependencies` 必须为空；对 `@opencode/*` / `effect` **只能 `import type`**；运行时不 spawn、不读写文件（持久化只走 `ctx.storage`，key `goal:<sessionID>`）。
- 入口两条路径都要顾（本地目录找 `<dir>/server.ts`；npm 走 `exports`）——本计划不改入口，只加命令/工具。
- i18n：面向用户文案必须在 `src/i18n/messages.ts` 的 `Messages` 接口 + `en.ts` + `zh-CN.ts` **三处同步**；`en`/`zh-CN` 键集合与占位符集合必须一致。
- **不本地化**：`src/prompts/` 的模型提示词、工具错误信息、`completionBudgetReport`、配置校验错误、`console.error` 日志。
- commit 信息用**中文**。
- `bun test` 不做类型检查，每个任务都要单独跑 `bunx tsc --noEmit`。
- 改 `src/**` 前确认插件是 **npm 安装**（当前就是，不 watch、不热重载）；若是本地目录安装，先临时从 `~/.config/opencode/opencode.json` 移除插件。

---

### Task 1: `Goal.continuations` + `recordContinuation`

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/model/goal.ts`
- Test: `src/model/goal.test.ts`

**Interfaces:**
- Produces: `Goal.continuations?: number`；`recordContinuation(goal: Goal, now: number): Goal`（计数 +1，刷新 `lastContinuationAt` / `updatedAt`）。

- [ ] **Step 1: 写失败测试**

在 `src/model/goal.test.ts` 末尾追加（若无 `recordContinuation` 的 import，先补进现有 import）：

```ts
import { createGoal, recordContinuation } from "./goal"

describe("recordContinuation", () => {
  test("counts from zero when the field is absent (legacy record)", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    const next = recordContinuation(goal, 111)
    expect(next.continuations).toBe(1)
    expect(next.lastContinuationAt).toBe(111)
    expect(next.updatedAt).toBe(111)
  })

  test("increments an existing count without mutating the input", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), continuations: 3 }
    const next = recordContinuation(goal, 5)
    expect(next.continuations).toBe(4)
    expect(goal.continuations).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/goal.test.ts`
Expected: FAIL —— `recordContinuation` 未导出（`SyntaxError` / `undefined is not a function`）。

- [ ] **Step 3: 加字段与函数**

`src/model/types.ts`：在 `lastContinuationAt?: number` 之后加：

```ts
  /** 自动续跑累计次数；旧记录（0.3.0 前）没有 → 读取时按 0 处理。 */
  readonly continuations?: number
```

`src/model/goal.ts`：在文件末尾（`complete` 之后）加：

```ts
/**
 * 落账一次自动续跑：计数 +1，并刷新 `lastContinuationAt` / `updatedAt`。
 * 口径 = 目标生命周期累计：`resume` / 暂停 / 各种停下都不重置。
 */
export function recordContinuation(goal: Goal, now: number): Goal {
  return { ...goal, continuations: (goal.continuations ?? 0) + 1, lastContinuationAt: now, updatedAt: now }
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `bun test src/model/goal.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/model/types.ts src/model/goal.ts src/model/goal.test.ts
git commit -m "feat(model): Goal 增加自动续跑累计计数与 recordContinuation"
```

---

### Task 2: `setBudget` + `invalid-budget` 错误码

**Files:**
- Modify: `src/model/goal.ts`（`GoalErrorCode`）
- Modify: `src/model/limits.ts`
- Test: `src/model/limits.test.ts`

**Interfaces:**
- Consumes: `GoalError`、`resume`（`./goal`）；`applyBudget`（本文件）。
- Produces:
  - `GoalErrorCode` 增加 `"invalid-budget"`。
  - `interface BudgetChange { readonly budget: number | undefined; readonly maxTokenBudget?: number; readonly now: number }`
  - `setBudget(goal: Goal, change: BudgetChange): Goal`

- [ ] **Step 1: 写失败测试**

在 `src/model/limits.test.ts` 末尾追加：

```ts
import type { Goal } from "./types"
import { GoalError, createGoal } from "./goal"
import { setBudget } from "./limits"

function base(overrides: Partial<Goal> = {}): Goal {
  return { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), ...overrides }
}

describe("setBudget", () => {
  test("sets a numeric budget on an active goal without changing status", () => {
    const goal = setBudget(base({ tokensUsed: 10 }), { budget: 100, now: 7 })
    expect(goal.tokenBudget).toBe(100)
    expect(goal.status).toBe("active")
    expect(goal.updatedAt).toBe(7)
  })

  test("clearing removes the key entirely (not tokenBudget: undefined)", () => {
    const goal = setBudget(base({ tokenBudget: 100, tokensUsed: 10 }), { budget: undefined, now: 7 })
    expect("tokenBudget" in goal).toBe(false)
    expect(goal.status).toBe("active")
  })

  test("lowering below usage marks an active goal budget-limited", () => {
    const goal = setBudget(base({ tokensUsed: 100 }), { budget: 50, now: 7 })
    expect(goal.status).toBe("budget-limited")
  })

  test("raising above usage turns a budget-limited goal back to active and clears the audit", () => {
    const goal = setBudget(
      base({
        status: "budget-limited",
        tokenBudget: 50,
        tokensUsed: 100,
        blockerKey: "k",
        blockerText: "t",
        blockerStreak: 2,
        emptyStreak: 1,
        lastError: { type: "provider.auth", message: "x", at: 1 },
      }),
      { budget: 500, now: 7 },
    )
    expect(goal.status).toBe("active")
    expect(goal.tokenBudget).toBe(500)
    expect(goal.blockerKey).toBeUndefined()
    expect(goal.blockerText).toBeUndefined()
    expect(goal.blockerStreak).toBe(0)
    expect(goal.emptyStreak).toBe(0)
    expect(goal.lastError).toBeUndefined()
  })

  test("clearing the budget also turns budget-limited back to active", () => {
    const goal = setBudget(base({ status: "budget-limited", tokenBudget: 50, tokensUsed: 100 }), {
      budget: undefined,
      now: 7,
    })
    expect(goal.status).toBe("active")
    expect("tokenBudget" in goal).toBe(false)
  })

  test("a still-insufficient budget leaves it budget-limited", () => {
    const goal = setBudget(base({ status: "budget-limited", tokenBudget: 10, tokensUsed: 100 }), {
      budget: 50,
      now: 7,
    })
    expect(goal.status).toBe("budget-limited")
  })

  test("a lower budget upgrades blocked / usage-limited to budget-limited (system fact wins)", () => {
    expect(setBudget(base({ status: "blocked", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("budget-limited")
    expect(setBudget(base({ status: "usage-limited", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe(
      "budget-limited",
    )
  })

  test("paused and complete goals only get the number, never a status change", () => {
    expect(setBudget(base({ status: "paused", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("paused")
    expect(setBudget(base({ status: "complete", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("complete")
  })

  test("rejects a non-positive / non-integer budget", () => {
    for (const budget of [0, -1, 1.5])
      expect(() => setBudget(base(), { budget, now: 7 })).toThrow(GoalError)
  })

  test("rejects a budget above maxTokenBudget, and only when budget is a number", () => {
    expect(() => setBudget(base(), { budget: 101, maxTokenBudget: 100, now: 7 })).toThrow(/exceeds max_goal_token_budget/)
    expect(setBudget(base(), { budget: undefined, maxTokenBudget: 100, now: 7 }).status).toBe("active")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/limits.test.ts`
Expected: FAIL —— `setBudget` 未导出。

- [ ] **Step 3: 实现**

`src/model/goal.ts` 第 4 行改成：

```ts
export type GoalErrorCode = "budget-exceeds-max" | "not-resumable" | "not-completable" | "invalid-budget"
```

`src/model/limits.ts` 改为：

```ts
import { GoalError, resume } from "./goal"
import type { Goal } from "./types"

/** 预算命中 → budget-limited。可从 active / blocked / usage-limited 升级（系统本地硬限压倒外部信号与模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "usage-limited") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}

export interface BudgetChange {
  /** 新预算；`undefined` = 无预算（清空）。 */
  readonly budget: number | undefined
  readonly maxTokenBudget?: number
  readonly now: number
}

/**
 * 随时改预算（不重建目标）。见 spec §3.3：
 * - 校验 → 写入（清空时**真正移除** `tokenBudget` 键）；
 * - 超出已用量 → 交 `applyBudget` 降级（active/blocked/usage-limited → budget-limited）；
 * - 原本 budget-limited 且新额度够用 → 走 `resume` 语义回 active（清 blocker 审计与 lastError）。
 */
export function setBudget(goal: Goal, change: BudgetChange): Goal {
  const { budget, maxTokenBudget, now } = change
  if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0))
    throw new GoalError("invalid-budget", "token_budget must be a positive integer")
  if (budget !== undefined && maxTokenBudget !== undefined && budget > maxTokenBudget)
    throw new GoalError("budget-exceeds-max", `token_budget ${budget} exceeds max_goal_token_budget ${maxTokenBudget}`)
  // 解构剔除旧键：`{ ...goal, tokenBudget: undefined }` 会留下显式键，清空必须真正删除。
  const { tokenBudget: _previous, ...rest } = goal
  const next: Goal =
    budget === undefined ? { ...rest, updatedAt: now } : { ...rest, tokenBudget: budget, updatedAt: now }
  if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) return applyBudget(next, now)
  if (next.status === "budget-limited") return resume(next, now)
  return next
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/model/limits.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/model/goal.ts src/model/limits.ts src/model/limits.test.ts
git commit -m "feat(model): setBudget 支持运行期改/清空 token 预算"
```

---

### Task 3: `token_budget` 接受 `0`（= 无预算）

**Files:**
- Modify: `src/model/tool-args.ts`
- Modify: `src/host/tools.ts`（仅 `create` 的 `tokenBudget` 映射）
- Test: `src/model/tool-args.test.ts`、`src/host/tools.test.ts`

**Interfaces:**
- Produces: `token_budget` 接受 `0`（= 无预算），负数/小数仍拒绝；`op="create"` 传 `0` 时忽略配置默认、建无预算目标。
- **注意**：本任务**不**动 `ToolOp` 联合类型——给联合加 `"budget"` 会迫使 `tools.ts` 的 `switch` 同时穷尽处理，否则 `execute` 返回类型变 `{content} | undefined`、`tsc` 报错。`budget` op 整体留给 Task 6。

- [ ] **Step 1: 写失败测试**

`src/model/tool-args.test.ts`：把「rejects a non-positive token_budget」整段替换为：

```ts
  test("accepts token_budget 0 (means no budget) but rejects negatives and fractions", () => {
    expect(parseToolArgs({ op: "create", token_budget: 0 })).toEqual({ ok: true, args: { op: "create", tokenBudget: 0 } })
    for (const token_budget of [-1, 1.5])
      expect(parseToolArgs({ op: "create", token_budget })).toEqual({
        ok: false,
        message: expect.stringContaining("token_budget"),
      })
  })
```

`src/host/tools.test.ts`：在 `create stores an active goal` 之后插入：

```ts
  test("create with token_budget 0 means no budget (ignores the config default)", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, tokenBudget: 999 } })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "create", objective: "x", token_budget: 0 }, ctx))
    expect(result.goal.tokenBudget).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/tool-args.test.ts src/host/tools.test.ts`
Expected: FAIL —— `create` + `token_budget: 0` 建出 `tokenBudget: 0`（不是无预算）。

- [ ] **Step 3: 实现**

`src/model/tool-args.ts` 的 token_budget 校验块改为：

```ts
  let tokenBudget: number | undefined
  if (record.token_budget !== undefined) {
    if (typeof record.token_budget !== "number" || !Number.isInteger(record.token_budget) || record.token_budget < 0)
      return { ok: false, message: "goal: token_budget must be a non-negative integer (0 = no budget)" }
    tokenBudget = record.token_budget
  }
```

`src/host/tools.ts` 的 `case "create"` 里：

```ts
            tokenBudget: args.tokenBudget === 0 ? undefined : (args.tokenBudget ?? deps.options.tokenBudget),
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/model/tool-args.test.ts src/host/tools.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/model/tool-args.ts src/model/tool-args.test.ts src/host/tools.ts src/host/tools.test.ts
git commit -m "feat(model,host): token_budget 支持 0=无预算（create 语义）"
```

---

### Task 4: `GoalView.continuations`

**Files:**
- Modify: `src/model/tool-result.ts`
- Test: `src/model/tool-result.test.ts`

**Interfaces:**
- Consumes: `Goal.continuations`（Task 1）。
- Produces: `GoalView.continuations: number`（缺省 0）。

- [ ] **Step 1: 写失败测试**

`src/model/tool-result.test.ts` 末尾追加：

```ts
describe("continuations", () => {
  test("defaults to 0 for a legacy goal without the field", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    expect(buildToolResult(goal).goal.continuations).toBe(0)
  })

  test("exposes the accumulated count", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), continuations: 3 }
    expect(buildToolResult(goal).goal.continuations).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/tool-result.test.ts`
Expected: FAIL —— `continuations` 为 `undefined`。

- [ ] **Step 3: 实现**

`src/model/tool-result.ts`：`GoalView` 在 `timeUsedSeconds: number` 之后加：

```ts
  /** 自动续跑累计次数。 */
  readonly continuations: number
```

`buildToolResult` 的返回对象里、`timeUsedSeconds: goal.timeUsedSeconds,` 之后加：

```ts
      continuations: goal.continuations ?? 0,
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/model/tool-result.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/model/tool-result.ts src/model/tool-result.test.ts
git commit -m "feat(model): 工具返回 GoalView 暴露自动续跑次数"
```

---

### Task 5: i18n 全量文案 + 续跑计数接线（continuation / statusLine）

**Files:**
- Modify: `src/i18n/messages.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-CN.ts`
- Modify: `src/host/continuation.ts`
- Modify: `src/host/commands.ts`（只改 `statusLine`）
- Test: `src/host/continuation.test.ts`、`src/host/commands.test.ts`

**Interfaces:**
- Consumes: `recordContinuation`（Task 1）。
- Produces: 全部新增/修改 i18n 键（后续 Task 6/7 直接使用）；`continuation.onIdle` 落账计数并在回执里带 `#N`。

> ⚠️ `status.line` 新增 `{continuations}` 占位符**必须**在同一任务里给 `statusLine` 传值，否则运行期回执残留 `{continuations}`。

- [ ] **Step 1: 写失败测试**

`src/host/continuation.test.ts` 第 2 个 import 改为：

```ts
import { createGoal, recordContinuation } from "../model/goal"
```

在第一个测试（`injects the continuation prompt...`）末尾的 `lastContinuationAt` 断言后追加：

```ts
    expect((await deps.repo.load("ses_1"))?.continuations).toBe(1)
    expect(sent[0]?.description).toContain("#1")
```

并新增一个测试（放在同一 describe 内）：

```ts
  test("counts every continuation cumulatively across turns", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const sent: string[] = []
    const continuation = createContinuation(deps, { deliver: async (input) => void sent.push(input.description) })
    await continuation.onIdle("ses_1", "build")
    await continuation.onIdle("ses_1", "build")
    expect((await deps.repo.load("ses_1"))?.continuations).toBe(2)
    expect(sent[1]).toContain("#2")
  })
```

`src/host/commands.test.ts` 的 `an empty goal argument reports the status instead of prompting the model` 测试里追加一行：

```ts
    expect(notices[0]).toContain("auto-continues 0")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/continuation.test.ts src/host/commands.test.ts`
Expected: FAIL —— description 不含 `#1`；status 行不含 `auto-continues 0`。

- [ ] **Step 3: 加 i18n 键（三处同步）**

`src/i18n/messages.ts`：`readonly "cmd.debug": string` 之后加

```ts
  readonly "cmd.budget": string
```

`readonly "notice.nothingToResume": string` 之后加

```ts
  readonly "notice.budgetSet": string
  readonly "notice.budgetCleared": string
  readonly "notice.budgetUsage": string
  readonly "notice.budgetInvalid": string
  readonly "notice.budgetExceedsMax": string
```

`readonly "status.noBudget": string` 之后加

```ts
  readonly "status.continuations": string
```

`src/i18n/en.ts`：

```ts
  "cmd.budget": 'Set the token budget for the current goal (a positive integer, or "none" to remove it).',
```

```ts
  "notice.budgetSet": "Budget set to {budget}; goal is now {status}.",
  "notice.budgetCleared": "Budget removed (unlimited); goal is now {status}.",
  "notice.budgetUsage": 'Usage: a positive integer, or "none" to remove the budget.',
  "notice.budgetInvalid": 'Invalid budget "{value}": use a positive integer, or "none" to remove it.',
  "notice.budgetExceedsMax": "Budget {budget} exceeds max_goal_token_budget {max}.",
```

```ts
  "status.continuations": "; auto-continues {count}",
```

并把 `"label.autoContinue"` 改为 `"Goal auto-continue #{count}"`、`"status.line"` 改为：

```ts
  "status.line": "Goal ({status}) — tokens {tokens} / {budget}{detail}; {seconds}s{lastError}{continuations}. Objective: {objective}",
```

（同时把 `"tool.goal.description"` / `"tool.goal.op"` / `"tool.goal.tokenBudget"` 改为 spec §3.7 表格里的新值。）

`src/i18n/zh-CN.ts`：与 en 一一对应加键/改值：

```ts
  "cmd.budget": "设置当前目标的 token 预算（正整数，或「none」取消预算）。",
```

```ts
  "notice.budgetSet": "预算已设为 {budget}；目标当前为「{status}」。",
  "notice.budgetCleared": "已取消预算（不限）；目标当前为「{status}」。",
  "notice.budgetUsage": "用法：正整数，或「none」取消预算。",
  "notice.budgetInvalid": "无效的预算「{value}」：请用正整数，或「none」取消预算。",
  "notice.budgetExceedsMax": "预算 {budget} 超过 max_goal_token_budget {max}。",
```

```ts
  "status.continuations": "；自动续跑 {count} 次",
```

```ts
  "label.autoContinue": "目标自动续跑 #{count}",
  "status.line": "目标（{status}）— tokens {tokens} / {budget}{detail}；{seconds}s{lastError}{continuations}。目标：{objective}",
```

（`tool.goal.*` 三个键同步改为 spec §3.7 的中文值。）

- [ ] **Step 4: 接线**

`src/host/continuation.ts` 顶部 import 改为：

```ts
import { format } from "../i18n/messages"
import { recordContinuation } from "../model/goal"
import { continuationTrigger } from "../prompts/index"
import type { GoalDeps } from "./deps"
import { noticeLine } from "./notice"
```

`onIdle` 中的投递与落账改为：

```ts
      const count = (goal.continuations ?? 0) + 1
      await port.deliver({
        sessionID,
        text: continuationTrigger(),
        description: noticeLine(format(deps.messages["label.autoContinue"], { count }), goal.objective),
      })
      const now = deps.now()
      await deps.repo.save(sessionID, recordContinuation(goal, now))
      return true
```

`src/host/commands.ts` 的 `statusLine`：在 `const usage = ...` 之后加

```ts
  const continuations = format(messages["status.continuations"], { count: goal.continuations ?? 0 })
```

并在 `format(messages["status.line"], { ... })` 的参数里加 `continuations,`。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test src/host/continuation.test.ts src/host/commands.test.ts src/i18n/messages.test.ts && bunx tsc --noEmit`
Expected: 全 PASS（`messages.test.ts` 自动覆盖新增键的键/占位符对齐）、tsc 0 错。

- [ ] **Step 6: Commit**

```bash
git add src/i18n src/host/continuation.ts src/host/continuation.test.ts src/host/commands.ts src/host/commands.test.ts
git commit -m "feat(i18n,host): 续跑计数落账与展示 + 预算相关文案"
```

---

### Task 6: 工具 `goal(op="budget")`

**Files:**
- Modify: `src/model/tool-args.ts`（`ToolOp` / `OPS` 加 `"budget"`）
- Modify: `src/host/tools.ts`
- Test: `src/model/tool-args.test.ts`、`src/host/tools.test.ts`

**Interfaces:**
- Consumes: `setBudget`（Task 2）、`messages["tool.goal.*"]`（Task 5）。
- Produces: `ToolOp` 含 `"budget"`；`op="budget"` 的完整行为（含 `0` = 无预算）。

- [ ] **Step 1: 写失败测试**

`src/model/tool-args.test.ts` 追加：

```ts
  test("accepts the budget op", () => {
    expect(parseToolArgs({ op: "budget", token_budget: 500 })).toEqual({
      ok: true,
      args: { op: "budget", tokenBudget: 500 },
    })
  })
```

`src/host/tools.test.ts` 末尾追加：

```ts
describe("budget op", () => {
  test("sets a budget on an existing goal", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x" }, ctx)
    const result = parse(await tool.execute({ op: "budget", token_budget: 500 }, ctx))
    expect(result.goal.tokenBudget).toBe(500)
    expect((await deps.repo.load("ses_1"))?.tokenBudget).toBe(500)
  })

  test("token_budget 0 clears the budget", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x", token_budget: 100 }, ctx)
    const result = parse(await tool.execute({ op: "budget", token_budget: 0 }, ctx))
    expect(result.goal.tokenBudget).toBeNull()
    expect("tokenBudget" in ((await deps.repo.load("ses_1")) as object)).toBe(false)
  })

  test("requires token_budget explicitly", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x" }, ctx)
    await expect(tool.execute({ op: "budget" }, ctx)).rejects.toThrow(/token_budget/)
  })

  test("errors without a goal and for a restricted agent", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "budget", token_budget: 10 }, ctx)).rejects.toThrow(/no goal/)

    const restricted = createGoalTool(makeDeps({ isRestricted: (agent) => agent === "plan" }))
    await restricted.execute({ op: "create", objective: "x" }, ctx)
    await expect(restricted.execute({ op: "budget", token_budget: 10 }, { sessionID: "ses_1", agent: "plan" })).rejects.toThrow(
      /restricted|budget/,
    )
  })

  test("rejects a budget above maxGoalTokenBudget", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, maxGoalTokenBudget: 100 } })
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x" }, ctx)
    await expect(tool.execute({ op: "budget", token_budget: 101 }, ctx)).rejects.toThrow(/max_goal_token_budget/)
  })

  test("lowering below the used tokens returns the budget-limit instruction", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x", token_budget: 100 }, ctx)
    await deps.repo.save("ses_1", { ...((await deps.repo.load("ses_1")) as never), tokensUsed: 100 })
    const result = parse(await tool.execute({ op: "budget", token_budget: 50 }, ctx))
    expect(result.goal.status).toBe("budget-limited")
    expect(result.instruction).toContain("token budget")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/tools.test.ts`
Expected: FAIL —— `budget` op 落到 `switch` 外（返回 `undefined`）或 `token_budget` 语义未实现。

- [ ] **Step 3: 实现**

`src/model/tool-args.ts`：`ToolOp` / `OPS` 加 `"budget"`（必须在**同一任务**里给 `tools.ts` 的 `switch` 补 case，否则 `execute` 返回类型不穷尽、`tsc` 报错）。

`src/host/tools.ts`：

import 改为：

```ts
import { GoalError, complete, createGoal, resume } from "../model/goal"
import { applyBudget, setBudget } from "../model/limits"
```

`goalToolInput` 的 `op` 枚举加 `"budget"`，`token_budget` 改为：

```ts
      token_budget: { type: "integer", minimum: 0, description: messages["tool.goal.tokenBudget"] },
```

在 `case "block"` 之前插入：

```ts
        case "budget": {
          if (deps.isRestricted(context.agent)) throw new Error("goal: this agent cannot change the budget")
          if (!existing) throw new Error("goal: no goal to change the budget of")
          if (args.tokenBudget === undefined)
            throw new Error("goal: token_budget is required for op budget (0 = no budget)")
          let goal: Goal
          try {
            goal = setBudget(existing, {
              budget: args.tokenBudget === 0 ? undefined : args.tokenBudget,
              maxTokenBudget: deps.options.maxGoalTokenBudget,
              now,
            })
          } catch (error) {
            if (error instanceof GoalError) throw new Error(`goal: ${error.message}`)
            throw error
          }
          await deps.repo.save(sessionID, goal)
          const result = view(goal)
          if (goal.status === "budget-limited")
            return asContent({
              ...result,
              instruction: budgetLimitPrompt(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }),
            })
          return asContent(result)
        }
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/host/tools.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/host/tools.ts src/host/tools.test.ts
git commit -m "feat(host): goal(op=budget) 支持运行期改/清空预算"
```

---

### Task 7: 命令 `/goal-budget` + 注册

**Files:**
- Modify: `src/host/commands.ts`
- Modify: `src/server.ts`
- Test: `src/host/commands.test.ts`、`src/server.test.ts`

**Interfaces:**
- Consumes: `setBudget`（Task 2）、`messages["cmd.budget"]` / `notice.budget*`（Task 5）。
- Produces: `parseBudgetArg(text)`；`GoalCommandHandlers.budget(sessionID, text)`；`${command_name}-budget` 已注册。

- [ ] **Step 1: 写失败测试**

`src/host/commands.test.ts`：import 增加 `parseBudgetArg`：

```ts
import { createCommandHandlers, parseBudgetArg, parseGoalCommand } from "./commands"
```

末尾追加：

```ts
describe("parseBudgetArg", () => {
  test("empty means usage", () => {
    expect(parseBudgetArg("")).toEqual({ kind: "usage" })
    expect(parseBudgetArg("   ")).toEqual({ kind: "usage" })
  })

  test("none / off / 0 clear the budget (case-insensitive)", () => {
    expect(parseBudgetArg("none")).toEqual({ kind: "clear" })
    expect(parseBudgetArg("OFF")).toEqual({ kind: "clear" })
    expect(parseBudgetArg("0")).toEqual({ kind: "clear" })
  })

  test("a positive integer sets it, anything else is invalid", () => {
    expect(parseBudgetArg("500")).toEqual({ kind: "set", budget: 500 })
    for (const raw of ["-5", "1.5", "5x", "500 000"])
      expect(parseBudgetArg(raw)).toEqual({ kind: "invalid", value: raw })
  })
})

describe("budget command", () => {
  test("usage / no goal / invalid are deterministic and touch no model turn", async () => {
    const { handlers, notices, prompts } = makeHandler()
    await handlers.budget("ses_1", "")
    expect(notices.at(-1)).toContain("Usage")

    await handlers.budget("ses_1", "-1")
    expect(notices.at(-1)).toContain("Invalid budget")

    await handlers.budget("ses_1", "500")
    expect(notices.at(-1)).toContain("No goal")
    expect(prompts).toHaveLength(0)
  })

  test("sets and clears the budget, reporting the resulting status", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 10 }))

    await handlers.budget("ses_1", "500")
    expect((await deps.repo.load("ses_1"))?.tokenBudget).toBe(500)
    expect(notices.at(-1)).toContain("Budget set to 500")
    expect(notices.at(-1)).toContain("active")

    await handlers.budget("ses_1", "none")
    const cleared = await deps.repo.load("ses_1")
    expect(cleared && "tokenBudget" in cleared).toBe(false)
    expect(notices.at(-1)).toContain("Budget removed")
  })

  test("raising the budget resumes a budget-limited goal, and the receipt says so", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 10 }),
      status: "budget-limited" as const,
      tokensUsed: 100,
    })
    await handlers.budget("ses_1", "500")
    expect((await deps.repo.load("ses_1"))?.status).toBe("active")
    expect(notices.at(-1)).toContain("active")
  })

  test("rejects a budget above maxGoalTokenBudget with a dedicated notice", async () => {
    const deps = { ...makeDeps(), options: { ...DEFAULT_OPTIONS, maxGoalTokenBudget: 100 } }
    const { handlers, notices } = runner(deps)
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handlers.budget("ses_1", "101")
    expect(notices.at(-1)).toContain("max_goal_token_budget 100")
  })
})
```

`src/server.test.ts`：命令数组断言改为：

```ts
    expect(env.commands.map((command) => command.name)).toEqual([
      "goal",
      "goal-status",
      "goal-pause",
      "goal-resume",
      "goal-clear",
      "goal-budget",
      "goal-debug",
    ])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/commands.test.ts src/server.test.ts`
Expected: FAIL —— `parseBudgetArg` 未导出 / `handlers.budget` 不存在 / 命令数组缺 `goal-budget`。

- [ ] **Step 3: 实现**

`src/host/commands.ts`：

import 增加：

```ts
import { GoalError, pause as pauseGoal, resume as resumeGoal } from "../model/goal"
import { setBudget } from "../model/limits"
```

（`Goal` 类型、`format`、`statusLabel` 已有。）

新增解析函数（放在 `parseGoalCommand` 之后）：

```ts
export type BudgetArg =
  | { readonly kind: "usage" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly budget: number }
  | { readonly kind: "invalid"; readonly value: string }

/** `/goal-budget` 参数：空 → 用法；none/off/0 → 清空；其余必须为正整数。 */
export function parseBudgetArg(text: string): BudgetArg {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "usage" }
  if (/^(none|off|0)$/i.test(trimmed)) return { kind: "clear" }
  if (/^[1-9]\d*$/.test(trimmed)) return { kind: "set", budget: Number(trimmed) }
  return { kind: "invalid", value: trimmed }
}
```

`GoalCommandHandlers` 接口加：

```ts
  /** `${name}-budget`：零 token 地改/清空当前目标的预算。 */
  readonly budget: (sessionID: string, text: string) => Promise<void>
```

在 `createCommandHandlers` 的 `clear` 之后加：

```ts
  const budget = async (sessionID: string, text: string): Promise<void> => {
    const parsed = parseBudgetArg(text)
    if (parsed.kind === "usage") return port.notify(sessionID, deps.messages["notice.budgetUsage"])
    if (parsed.kind === "invalid")
      return port.notify(sessionID, format(deps.messages["notice.budgetInvalid"], { value: parsed.value }))
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    const desired = parsed.kind === "clear" ? undefined : parsed.budget
    let goal: Goal
    try {
      goal = setBudget(existing, { budget: desired, maxTokenBudget: deps.options.maxGoalTokenBudget, now: deps.now() })
    } catch (error) {
      if (error instanceof GoalError && error.code === "budget-exceeds-max")
        return port.notify(
          sessionID,
          format(deps.messages["notice.budgetExceedsMax"], {
            budget: desired ?? 0,
            max: deps.options.maxGoalTokenBudget ?? 0,
          }),
        )
      if (error instanceof GoalError)
        return port.notify(sessionID, format(deps.messages["notice.budgetInvalid"], { value: text.trim() }))
      throw error
    }
    await deps.repo.save(sessionID, goal)
    const status = statusLabel(deps.messages, goal.status)
    return port.notify(
      sessionID,
      desired === undefined
        ? format(deps.messages["notice.budgetCleared"], { status })
        : format(deps.messages["notice.budgetSet"], { budget: desired, status }),
    )
  }
```

返回对象里加 `budget,`。

`src/server.ts`：在 `-clear` 之后、`debugCommandName` 之前插入：

```ts
      editor.add({
        name: `${name}-budget`,
        description: messages["cmd.budget"],
        execute: async (input) => handlers.budget(input.sessionID, input.prompt.text),
      })
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/host/commands.test.ts src/server.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/host/commands.ts src/host/commands.test.ts src/server.ts src/server.test.ts
git commit -m "feat(host): 新增 /goal-budget 命令（改/清空预算）"
```

---

### Task 8: `/goal-debug state` 暴露续跑次数

**Files:**
- Modify: `src/host/debug.ts`
- Test: `src/host/debug.test.ts`

**Interfaces:**
- Consumes: `Goal.continuations`（Task 1）。

- [ ] **Step 1: 写失败测试**

`src/host/debug.test.ts` 中找到断言 `debug.state.goal` 的用例（`goal:` 行），追加一条（把目标先存成带计数的）：

```ts
  test("state includes the auto-continue count", async () => {
    const { deps, debug } = makeDebug()
    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), continuations: 4 })
    const text = await debug.render("state", "ses_1")
    expect(text).toContain("continuations=4")
  })
```

> 若 `debug.test.ts` 的 helper 不叫 `makeDebug`，用该文件现有的构造方式（`createDebug(deps, { pluginId, snapshot })`）对着写。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/debug.test.ts`
Expected: FAIL —— 不含 `continuations=4`。

- [ ] **Step 3: 实现**

`src/host/debug.ts` 的 `renderState` 里，`format(messages["debug.state.goal"], { goal: ... })` 的模板串改为：

```ts
            : `${goal.status}, continuations=${goal.continuations ?? 0}, emptyStreak=${goal.emptyStreak}, blockerStreak=${goal.blockerStreak}`,
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/host/debug.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/host/debug.ts src/host/debug.test.ts
git commit -m "feat(host): /goal-debug state 显示自动续跑次数"
```

---

### Task 9: 模型提示词的防自扩展措辞

**Files:**
- Modify: `src/prompts/index.ts`
- Test: `src/prompts/index.test.ts`

**Interfaces:**
- Produces: `budgetLimitPrompt` 里禁止模型自行加预算；`goalContext` 的 op 列表含 `budget`；`goalCommandPrompt` 措辞覆盖「改预算」。

- [ ] **Step 1: 写失败测试**

`src/prompts/index.test.ts`：`budgetLimitPrompt is a wrap-up instruction` 测试追加：

```ts
    expect(budgetLimitPrompt(goal, { maxObjectiveChars: 4000 })).toContain('op "budget"')
```

`goalContext` 的 `carries the escaped objective...` 测试追加：

```ts
    expect(text).toContain('"budget"')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/prompts/index.test.ts`
Expected: FAIL —— 两处均不含。

- [ ] **Step 3: 实现**

`src/prompts/index.ts`：

1. `goalContext` 中 `Every state change goes through the goal tool ("create" / "complete" / "block" / "resume" / "drop").` 改为

```
Every state change goes through the goal tool ("create" / "complete" / "block" / "resume" / "drop" / "budget").
```

2. `budgetLimitPrompt` 末尾（`Do not call goal with op "complete" ...` 那句之后）加一行：

```
Do not call goal with op "budget" unless the user explicitly asked for a new budget.
```

3. `goalCommandPrompt` 最后一句 `Do not set a token_budget unless the user explicitly gave one.` 改为

```
Do not set or change a token budget unless the user explicitly gave one.
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/prompts/index.test.ts && bunx tsc --noEmit`
Expected: 全 PASS、tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/prompts/index.ts src/prompts/index.test.ts
git commit -m "feat(prompts): 禁止模型自行加预算并补 budget op 说明"
```

---

### Task 10: 文档与 CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`
- Modify: `docs/opencode/smoke-checklist.md`

**Interfaces:**
- 无代码接口。

- [ ] **Step 1: 更新 README**

`README.md` 用法表加一行（放在 `/goal-clear` 之后）：

```markdown
| `/goal-budget <正整数\|none>` | 改当前目标的 token 预算（`none` 取消预算、不限） |
```

「设定后目标会在多轮之间持续…」那段下面补一条 bullet：

```markdown
- **自动续跑有计数**：`/goal-status` 会显示「自动续跑 N 次」，每次续跑的回执带 `#N`。
```

- [ ] **Step 2: 更新 CHANGELOG**

`CHANGELOG.md` 在 `## [Unreleased]` 下加：

```markdown
### Added

- **自动续跑计数**：目标累计记录自动续跑次数，展示在 `/goal-status`、续跑回执（`目标自动续跑 #N`）、`goal(op="get")` 返回与 `/goal-debug state`。
- **预算随时可改**：新增命令 `/goal-budget <正整数|none>`（`none` 取消预算，不限）与工具 `goal(op="budget", token_budget=…)`（`0` = 无预算）；把预算改到够用会把 `budget-limited` 的目标自动恢复为进行中，仍受 `max_goal_token_budget` 约束（`none` 除外）。
```

- [ ] **Step 3: 更新文档索引与冒烟清单**

`docs/README.md` 的 specs 索引里，V2 子项目那行补上本 spec（`superpowers/specs/2026-09-26-opencode-goal-v2-continuation-count-and-budget-design.md`）。

`docs/opencode/smoke-checklist.md` 末尾追加一节（照现有小节格式）：

```markdown
## §10 自动续跑计数 + 预算随时可调（v0.3.0）

- 目标跨轮续跑：notice 依次显示 `目标自动续跑 #1` / `#2`…；`/goal-status` 显示「自动续跑 N 次」。
- `token_budget=1` → `budget-limited` → `/goal-budget 500000`：状态回 `进行中`，回执「预算已设为 500000；目标当前为「进行中」。」；再发一条消息后继续续跑。
- `/goal-budget none`：回执「已取消预算（不限）；…」，`/goal-status` 显示「无预算」。
- 对话式「预算加到 50 万」：模型调用 `goal(op="budget", token_budget=500000)`。
- 回归：`smoke-api.mjs --scenario budget` PASS；`--scenario continuation` 的 `cont <= succeeded` 仍成立。
```

- [ ] **Step 4: 校验**

Run: `node scripts/changelog.mjs check && bun test && bunx tsc --noEmit`
Expected: `✓ 版本一致`；全 PASS；tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/README.md docs/opencode/smoke-checklist.md
git commit -m "docs: 补续跑计数与预算随时可调的用法、CHANGELOG 与冒烟清单"
```

---

## 自查（写完计划后对照 spec）

- **Spec 覆盖**：§3.1→Task 1；§3.2→Task 5；§3.3→Task 2；§3.4→Task 7；§3.5→Task 3/6；§3.6→Task 4/5/8；§3.7→Task 5；§3.8→Task 6/7；§5 真值表→Task 2；§6 验收→Task 10 Step 4；§9 参考无需落地。
- **占位符扫描**：每个代码步骤都给了可直接粘贴的实现，无 TBD / 「类似上文」。
- **类型一致性**：`recordContinuation(goal, now)`、`setBudget(goal, { budget, maxTokenBudget, now })`、`parseBudgetArg(text)`、`GoalCommandHandlers.budget(sessionID, text)`、`GoalView.continuations`、`BudgetArg` 的四个 `kind` 在各任务间一致。
- **已知取舍**：Task 3 放宽 `token_budget` 后、Task 6 落地前，`create` + `token_budget: 0` 存在一个**仅存在于开发树**的瞬态不一致（无测试覆盖、不发布）；Task 5 的 `tool.goal.*` 文案先于 Task 6 的工具枚举落地，同理。

## 验收

- `bun test` 全绿；`bunx tsc --noEmit` 0 错；`node scripts/changelog.mjs check` 通过。
- 全部任务完成后由主会话派人独立审查（spec / plan / 分支三层），再过真机冒烟（见 spec §6 真机清单）。
