# 宿主信号 → 状态（V2 子项目 3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把宿主**终态失败**信号映射为 goal 状态——配额/限流 → `usage-limited`，一小组确定性拒绝错误 → `blocked`——并记录 `lastError`、发纯回执、支持 `/goal-resume`。

**Architecture:** 新增纯函数模块 `model/signals.ts`（错误分类 + 状态转移）；状态机 `GoalStatus` 增加 `usage-limited`、`Goal` 增加可选 `lastError`；`host/events.ts` 把 `session.execution.failed` 从 `succeeded` 分支拆出，在结算后套用信号并回执；展示层（工具返回 / `/goal-status`）透传 `lastError`；`server.ts` 把 `notify` 传给事件路由。

**Tech Stack:** TypeScript（ESM，无构建，bun 直接加载 `.ts`）、Bun 1.4（`bun test`）、OpenCode V2 `@opencode/plugin@2.0.16`（仅 `import type`）。

**Spec:** `docs/superpowers/specs/2026-09-25-opencode-goal-v2-host-signals-design.md`（实现时以它为准；本计划从它推导）

## Global Constraints

- **仅 OpenCode V2**；宿主 API 以 `../Externals/opencode`（相对仓库根）为准。不做 v1 适配。
- 仓库内**不写机器绝对路径**；插件**不 spawn 子进程**。
- 状态名用**连字符**：`usage-limited`（不是 `usage_limited`）。
- **不加配置开关**；**不做自动恢复**；**不干预重试决策**（不注册 `retry` hook）。
- 映射范围**固定**：`provider.quota → usage-limited`；`provider.auth` / `provider.content-filter` / `provider.invalid-request → blocked`；**其它一切不改状态**（尤其 `provider.no-route` / `provider.timeout` / `provider.unsupported-operation` / 全部可重试类）。
- 优先级：`budget-limited` > `usage-limited` > `blocked`。
- 每个任务结束跑 `bun test`；涉及类型改动时同时跑 `bunx tsc --noEmit`（须 0 错）。
- **Git 提交信息用中文**。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/model/signals.ts` | 新建 | 纯函数：`hostSignal(error)` 分类 + `applyHostSignal(goal, now, signal)` 转移 |
| `src/model/signals.test.ts` | 新建 | 上述两函数的单测 |
| `src/model/types.ts` | 修改 | `GoalStatus` 加 `usage-limited`；`Goal` 加 `lastError` |
| `src/model/goal.ts` | 修改 | `resume()` 支持 `usage-limited` 并清 `lastError` |
| `src/model/goal.test.ts` | 修改 | resume 用例 |
| `src/model/limits.ts` | 修改 | `applyBudget` 升级来源加 `usage-limited` |
| `src/model/limits.test.ts` | 修改 | 预算升级用例 |
| `src/model/tool-result.ts` | 修改 | `GoalView` 加 `lastError`，透传 |
| `src/model/tool-result.test.ts` | 修改 | `lastError` 展示用例 |
| `src/store/repository.ts` | 修改 | `decodeGoal` 校验 `lastError`（畸形则丢弃字段、保留目标） |
| `src/store/repository.test.ts` | 修改 | `lastError` 往返/畸形用例 |
| `src/host/notice.ts` | 修改 | 新增 `signalNotice(status, message)` |
| `src/host/events.ts` | 修改 | 拆 `failed` 分支；套用信号 + 回执；`createEventRouter` 加 `notify` 参数 |
| `src/host/events.test.ts` | 修改 | `makeRouter` 转发 notify；信号相关用例 |
| `src/host/commands.ts` | 修改 | `statusLine` 展示 `lastError` |
| `src/host/commands.test.ts` | 修改 | status 行用例 |
| `src/server.ts` | 修改 | `createEventRouter(deps, continuation, notify)`；resume 命令描述补 `usage-limited` |
| `CHANGELOG.md` / `docs/opencode/known-issues.md` | 修改 | 回填（Task 6） |

---

## Task 1: 信号分类与转移（`model/signals.ts` + `model/types.ts`）

**Files:**
- Create: `src/model/signals.ts`
- Create: `src/model/signals.test.ts`
- Modify: `src/model/types.ts`

**Interfaces:**
- Produces:
  - `interface HostSignal { readonly status: "usage-limited" | "blocked"; readonly type: string; readonly message: string }`
  - `function hostSignal(error: unknown): HostSignal | undefined`
  - `function applyHostSignal(goal: Goal, now: number, signal: HostSignal): Goal`
  - `type GoalStatus` 增加 `"usage-limited"`；`interface GoalLastError { type: string; message: string; at: number }`；`Goal.lastError?: GoalLastError`

- [ ] **Step 1: 写失败测试 `src/model/signals.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { createGoal } from "./goal"
import { applyHostSignal, hostSignal } from "./signals"

describe("hostSignal", () => {
  test("maps provider.quota to usage-limited", () => {
    expect(hostSignal({ type: "provider.quota", message: "weekly usage limit reached" })).toEqual({
      status: "usage-limited",
      type: "provider.quota",
      message: "weekly usage limit reached",
    })
  })

  test("maps deterministic rejections to blocked", () => {
    for (const type of ["provider.auth", "provider.content-filter", "provider.invalid-request"]) {
      expect(hostSignal({ type, message: "x" })).toEqual({ status: "blocked", type, message: "x" })
    }
  })

  test("ignores excluded and unknown types", () => {
    for (const type of [
      "provider.no-route",
      "provider.timeout",
      "provider.unsupported-operation",
      "provider.rate-limit",
      "provider.internal",
      "provider.transport",
      "provider.invalid-output",
      "provider.unknown",
      "permission.rejected",
      "tool.execution",
      "aborted",
      "unknown",
    ])
      expect(hostSignal({ type, message: "x" })).toBeUndefined()
  })

  test("ignores malformed errors", () => {
    expect(hostSignal(undefined)).toBeUndefined()
    expect(hostSignal(null)).toBeUndefined()
    expect(hostSignal("provider.quota")).toBeUndefined()
    expect(hostSignal({})).toBeUndefined()
    expect(hostSignal({ type: 123 })).toBeUndefined()
    expect(hostSignal({ type: "" })).toBeUndefined()
  })

  test("defaults a missing message to an empty string", () => {
    expect(hostSignal({ type: "provider.quota" })).toEqual({ status: "usage-limited", type: "provider.quota", message: "" })
  })
})

describe("applyHostSignal", () => {
  const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
  const signal = { status: "usage-limited" as const, type: "provider.quota", message: "quota" }

  test("marks an active goal and records lastError", () => {
    const next = applyHostSignal(goal, 2000, signal)
    expect(next.status).toBe("usage-limited")
    expect(next.lastError).toEqual({ type: "provider.quota", message: "quota", at: 2000 })
    expect(next.updatedAt).toBe(2000)
  })

  test("upgrades a blocked goal without touching the model-reported blocker fields", () => {
    const blocked = { ...goal, status: "blocked" as const, blockerKey: "k", blockerText: "t", blockerStreak: 2 }
    const next = applyHostSignal(blocked, 2000, { status: "blocked" as const, type: "provider.auth", message: "auth" })
    expect(next.status).toBe("blocked")
    expect(next.lastError?.type).toBe("provider.auth")
    expect(next.blockerKey).toBe("k")
    expect(next.blockerStreak).toBe(2)
  })

  test("leaves non-active/non-blocked statuses untouched", () => {
    for (const status of ["paused", "complete", "usage-limited", "budget-limited"] as const) {
      const g = { ...goal, status }
      expect(applyHostSignal(g, 2000, signal)).toBe(g)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/signals.test.ts`
Expected: FAIL —— `Cannot find module "./signals"`。

- [ ] **Step 3: 改 `src/model/types.ts`**

把首行替换为：

```ts
export type GoalStatus = "active" | "paused" | "blocked" | "budget-limited" | "usage-limited" | "complete"
```

在 `GoalUsage` 接口之后、`Goal` 接口之前插入：

```ts
/** 宿主终态信号落下的最近一次错误（展示用；与模型报障的 blocker* 字段无关）。 */
export interface GoalLastError {
  readonly type: string
  readonly message: string
  readonly at: number
}
```

在 `Goal` 接口里、`readonly emptyStreak: number` 之后加一行：

```ts
  /** 最近一次宿主终态错误；仅由 host 信号写入，resume 时清空。 */
  readonly lastError?: GoalLastError
```

- [ ] **Step 4: 写 `src/model/signals.ts`**

```ts
import type { Goal } from "./types"

export interface HostSignal {
  readonly status: "usage-limited" | "blocked"
  readonly type: string
  readonly message: string
}

/**
 * 宿主终态错误（`session.execution.failed` 的 `data.error`）→ goal 状态。
 * 只映射 spec §4.1 固定的一组；其余（含 no-route/timeout/unsupported 与全部可重试类）返回 undefined。
 */
export function hostSignal(error: unknown): HostSignal | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  const type = record.type
  if (typeof type !== "string" || type.length === 0) return undefined
  const message = typeof record.message === "string" ? record.message : ""
  if (type === "provider.quota") return { status: "usage-limited", type, message }
  if (type === "provider.auth" || type === "provider.content-filter" || type === "provider.invalid-request")
    return { status: "blocked", type, message }
  return undefined
}

/**
 * 状态转移（spec §4.3）：仅当 goal.status ∈ {active, blocked} 时改状态并记 lastError；
 * 其它状态（paused/complete/usage-limited/budget-limited）原样返回同一引用。
 */
export function applyHostSignal(goal: Goal, now: number, signal: HostSignal): Goal {
  if (goal.status !== "active" && goal.status !== "blocked") return goal
  return {
    ...goal,
    status: signal.status,
    lastError: { type: signal.type, message: signal.message, at: now },
    updatedAt: now,
  }
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test src/model/signals.test.ts && bunx tsc --noEmit`
Expected: PASS；tsc 0 错。

- [ ] **Step 6: 全量测试（防止状态名新增导致别处类型/逻辑回归）**

Run: `bun test`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/model/signals.ts src/model/signals.test.ts src/model/types.ts
git commit -m "feat(model): 宿主终态信号分类与状态转移（usage-limited / blocked）"
```

---

## Task 2: resume 与预算优先级（`model/goal.ts` + `model/limits.ts`）

**Files:**
- Modify: `src/model/goal.ts:52-56`
- Modify: `src/model/goal.test.ts`
- Modify: `src/model/limits.ts:4-8`
- Modify: `src/model/limits.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GoalStatus`（含 `usage-limited`）、`Goal.lastError`。
- Produces: `resume()` 支持 `usage-limited` 且清 `lastError`；`applyBudget()` 可把 `usage-limited` 升级为 `budget-limited`。

- [ ] **Step 1: 加失败测试**

在 `src/model/goal.test.ts` 的 `describe("transitions", …)` 内、`test("resumes from budget-limited", …)` 之后加：

```ts
  test("resumes from usage-limited and clears lastError", () => {
    const limited = {
      ...goal,
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit", at: 1234 },
    }
    const resumed = resume(limited, 6000)
    expect(resumed.status).toBe("active")
    expect(resumed.lastError).toBeUndefined()
  })
```

在 `src/model/limits.test.ts` 的 `describe("applyBudget", …)` 内、末尾加：

```ts
  test("upgrades a usage-limited goal to budget-limited when over budget (budget outranks usage limit)", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }),
      status: "usage-limited" as const,
      tokensUsed: 100,
    }
    const limited = applyBudget(goal, 10)
    expect(limited.status).toBe("budget-limited")
    expect(limited.updatedAt).toBe(10)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/goal.test.ts src/model/limits.test.ts`
Expected: FAIL —— `not-resumable`（usage-limited 不在白名单）；usage-limited 未被升级。

- [ ] **Step 3: 改 `src/model/goal.ts` 的 `resume`**

替换整个 `resume` 函数：

```ts
export function resume(goal: Goal, now: number): Goal {
  if (
    goal.status !== "paused" &&
    goal.status !== "blocked" &&
    goal.status !== "budget-limited" &&
    goal.status !== "usage-limited"
  )
    throw new GoalError("not-resumable", `not-resumable: cannot resume a ${goal.status} goal`)
  return next(goal, "active", now, {
    blockerKey: undefined,
    blockerText: undefined,
    blockerStreak: 0,
    emptyStreak: 0,
    lastError: undefined,
  })
}
```

- [ ] **Step 4: 改 `src/model/limits.ts`**

```ts
import type { Goal } from "./types"

/** 预算命中 → budget-limited。可从 active / blocked / usage-limited 升级（系统本地硬限压倒外部信号与模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "usage-limited") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test src/model/goal.test.ts src/model/limits.test.ts && bunx tsc --noEmit`
Expected: PASS；tsc 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/model/goal.ts src/model/goal.test.ts src/model/limits.ts src/model/limits.test.ts
git commit -m "feat(model): usage-limited 可 resume，且预算可将其升级为 budget-limited"
```

---

## Task 3: `lastError` 的展示与持久化（`model/tool-result.ts` + `store/repository.ts`）

**Files:**
- Modify: `src/model/tool-result.ts`
- Modify: `src/model/tool-result.test.ts`
- Modify: `src/store/repository.ts:26-53`
- Modify: `src/store/repository.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GoalLastError`、`Goal.lastError`。
- Produces: `GoalView.lastError: GoalLastError | null`；`decodeGoal` 对 `lastError` 做可选校验。

- [ ] **Step 1: 加失败测试**

在 `src/model/tool-result.test.ts` 的 `describe` 内加：

```ts
  test("reports lastError as null when absent", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    expect(buildToolResult(goal).goal.lastError).toBeNull()
  })

  test("exposes lastError when present", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit", at: 7 },
    }
    expect(buildToolResult(goal).goal.lastError).toEqual({ type: "provider.quota", message: "weekly usage limit", at: 7 })
  })
```

在 `src/store/repository.test.ts` 的 `describe("repository", …)` 内加：

```ts
  test("decodeGoal keeps an optional lastError", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, lastError: { type: "provider.quota", message: "q", at: 9 } })
    expect(decoded?.lastError).toEqual({ type: "provider.quota", message: "q", at: 9 })
  })

  test("decodeGoal drops a malformed lastError but keeps the goal", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, lastError: { type: 5 } })
    expect(decoded).toBeDefined()
    expect(decoded?.lastError).toBeUndefined()
    expect(decoded?.goalId).toBe("g1")
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/model/tool-result.test.ts src/store/repository.test.ts`
Expected: FAIL —— `lastError` 未定义（tool-result 属性缺失；repository 的畸形值被原样带出）。

- [ ] **Step 3: 改 `src/model/tool-result.ts`**

首行 import 增加 `GoalLastError`：

```ts
import type { Goal, GoalLastError, GoalStatus, GoalUsage } from "./types"
```

`GoalView` 接口里、`readonly blockerStreak: number` 之前加：

```ts
  readonly lastError: GoalLastError | null
```

`buildToolResult` 的 `goal: { … }` 里、`blockerKey: goal.blockerKey ?? null,` 之前加：

```ts
      lastError: goal.lastError ?? null,
```

- [ ] **Step 4: 改 `src/store/repository.ts` 的 `decodeGoal`**

把 `decodeGoal` 中「usage 可选校验」那段（`if (record.usage !== undefined …) { … return … }`，**连同它上面第 34 行那句 usage 注释一起**）替换为统一处理（避免留下重复注释）：

```ts
  // 可选展示字段：形状不对就丢弃该字段、保留目标（不因为一个字段把整条记录判死）。
  const copy: Record<string, unknown> = { ...record }
  let dirty = false
  if (copy.usage !== undefined && !isUsage(copy.usage)) {
    delete copy.usage
    dirty = true
  }
  if (copy.lastError !== undefined && !isLastError(copy.lastError)) {
    delete copy.lastError
    dirty = true
  }
  return dirty ? (copy as unknown as Goal) : (value as Goal)
```

在 `isUsage` 函数之后加：

```ts
function isLastError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const e = value as Record<string, unknown>
  return typeof e.type === "string" && typeof e.message === "string" && typeof e.at === "number"
}
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test src/model/tool-result.test.ts src/store/repository.test.ts && bunx tsc --noEmit`
Expected: PASS；tsc 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/model/tool-result.ts src/model/tool-result.test.ts src/store/repository.ts src/store/repository.test.ts
git commit -m "feat(model,store): lastError 的展示与持久化校验"
```

---

## Task 4: 事件接线（`host/events.ts` + `host/notice.ts` + `server.ts`）

**Files:**
- Modify: `src/host/notice.ts`
- Modify: `src/host/events.ts`
- Modify: `src/host/events.test.ts`
- Modify: `src/host/debug.test.ts:42`
- Modify: `src/server.ts:59`

**Interfaces:**
- Consumes: Task 1 的 `hostSignal` / `applyHostSignal`。
- Produces: `createEventRouter(deps, continuation, notify)`（第三参 `notify: (sessionID: string, text: string) => Promise<void>`）；`signalNotice(status, message): string`。

- [ ] **Step 1: 加失败测试**

在 `src/host/events.test.ts` 顶部 import 之后，把 `makeRouter` 改为可收集回执：

```ts
function makeRouter(deps: GoalDeps, continuation: Continuation, notices: string[] = []) {
  const inner = createEventRouter(deps, continuation, async (_sessionID, text) => {
    notices.push(text)
  })
  return {
    handle: (event: { type: string; data?: Record<string, unknown>; location?: { directory?: unknown } }) =>
      inner.handle({ location: { directory: deps.locationDirectory }, ...event }),
    pendingUsage: (sessionID: string) => inner.pendingUsage(sessionID),
    diagnostics: () => inner.diagnostics(),
  }
}
```

在 `executionFailed` helper 之后加：

```ts
const executionFailedWithError = (sessionID: string, error: Record<string, unknown>) => ({
  type: "session.execution.failed",
  data: { sessionID, error },
})
```

> **`notify` 是必填第三参**，因此还要改两处**直接**调用 `createEventRouter` 的既有测试（第三参传空实现即可）：
> - 本文件的 `an unlocated execution end is admitted via the session's directory` 与 `unlocated events for another location's session are ignored`：`createEventRouter(deps, { onIdle: … }, async () => {})`；
> - `src/host/debug.test.ts:42`：`const router = createEventRouter(deps, { onIdle: async () => false }, async () => {})`。
>
> 漏改这 3 处 → `bunx tsc --noEmit` 报 TS2554（`bun test` 不类型检查，不会暴露）。

在 `describe("createEventRouter", …)` 内、末尾加：

```ts
  test("a quota failure marks the goal usage-limited and notifies once", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    await router.handle(executionStarted("ses_1"))
    await router.handle(
      executionFailedWithError("ses_1", { type: "provider.quota", message: "weekly usage limit reached" }),
    )
    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("usage-limited")
    expect(goal?.lastError).toEqual({ type: "provider.quota", message: "weekly usage limit reached", at: 1000 })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("usage-limited")
  })

  test("a quota failure with an empty message omits the detail clause", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionFailedWithError("ses_1", { type: "provider.quota", message: "" }))
    expect(notices[0]).toBe("Goal marked usage-limited. Use /goal-resume after the limit resets.")
  })

  test("an auth failure marks the goal blocked and notifies", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionFailedWithError("ses_1", { type: "provider.auth", message: "invalid api key" }))
    expect((await deps.repo.load("ses_1"))?.status).toBe("blocked")
    expect(notices[0]).toContain("blocked")
  })

  test("excluded and retryable failures leave the status unchanged and stay silent", async () => {
    for (const type of ["provider.no-route", "provider.timeout", "provider.rate-limit", "provider.unknown"]) {
      const deps = makeDeps()
      await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
      const notices: string[] = []
      const router = makeRouter(deps, { onIdle: async () => false }, notices)
      await router.handle(executionStarted("ses_1"))
      await router.handle(executionFailedWithError("ses_1", { type, message: "x" }))
      expect((await deps.repo.load("ses_1"))?.status).toBe("active")
      expect(notices).toHaveLength(0)
    }
  })

  test("a host signal applies even without an open turn", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    // 未收到 execution.started（模拟插件重启后接入）
    await router.handle(executionFailedWithError("ses_1", { type: "provider.quota", message: "quota" }))
    expect((await deps.repo.load("ses_1"))?.status).toBe("usage-limited")
    expect(notices).toHaveLength(1)
  })

  test("a host signal does not touch a paused or completed goal", async () => {
    for (const status of ["paused", "complete", "budget-limited"] as const) {
      const deps = makeDeps()
      const base = createGoal({ goalId: "g1", objective: "o", now: 0 })
      await deps.repo.save("ses_1", { ...base, status })
      const notices: string[] = []
      const router = makeRouter(deps, { onIdle: async () => false }, notices)
      await router.handle(executionStarted("ses_1"))
      await router.handle(executionFailedWithError("ses_1", { type: "provider.quota", message: "quota" }))
      expect((await deps.repo.load("ses_1"))?.status).toBe(status)
      expect(notices).toHaveLength(0)
    }
  })

  test("a host signal on an already usage-limited goal is a no-op with no notice", async () => {
    const deps = makeDeps()
    const base = createGoal({ goalId: "g1", objective: "o", now: 0 })
    await deps.repo.save("ses_1", { ...base, status: "usage-limited", lastError: { type: "provider.quota", message: "old", at: 1 } })
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionFailedWithError("ses_1", { type: "provider.auth", message: "auth" }))
    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("usage-limited")
    expect(goal?.lastError?.message).toBe("old")
    expect(notices).toHaveLength(0)
  })

  test("a failed turn still settles accounting and never continues", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle(executionStarted("ses_1"))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    await router.handle(executionFailedWithError("ses_1", { type: "provider.quota", message: "quota" }))
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(167)
    expect(prompts).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/events.test.ts`
Expected: FAIL —— `createEventRouter` 目前只接受 2 个参数（第三参被忽略），信号未实现（状态仍 `active`、`notices` 为空）。

- [ ] **Step 3: 改 `src/host/notice.ts`**

在文件末尾追加：

```ts
import type { GoalStatus } from "../model/types"

/** 宿主信号改状态后的纯回执行（`session.synthetic` 的 description 与 text 同用）。 */
export function signalNotice(status: GoalStatus, message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  const detail = flat.length === 0 ? "" : `: ${flat}`
  if (status === "usage-limited") return `Goal marked usage-limited${detail}. Use /goal-resume after the limit resets.`
  if (status === "budget-limited") return `Goal marked budget-limited${detail}. Use /goal-resume to continue.`
  return `Goal marked blocked${detail}. Use /goal-resume after resolving it.`
}
```

- [ ] **Step 4: 改 `src/host/events.ts`**

顶部 import 增加：

```ts
import { applyHostSignal, hostSignal } from "../model/signals"
import { signalNotice } from "./notice"
```

`EventRouter` 之前加类型：

```ts
export type Notify = (sessionID: string, text: string) => Promise<void>
```

`createEventRouter` 签名改为：

```ts
export function createEventRouter(deps: GoalDeps, continuation: Continuation, notify: Notify): EventRouter {
```

把现有的合并分支：

```ts
        case "session.execution.succeeded":
        case "session.execution.failed": {
          // 轮结束才结算；未开轮的结束事件（插件重启后接入）不结算、不续跑。
          if (!turnOpen.has(sessionID)) return
          turnOpen.delete(sessionID)
          const facts = tracker(sessionID).finish()
          const reportedBlocker = blockedThisTurn.get(sessionID) === true
          blockedThisTurn.set(sessionID, false)
          const usage = turnUsage.get(sessionID)
          turnUsage.delete(sessionID)
          let blocked = false
          await save(sessionID, (goal, now) => {
            // 先记账（整轮，含收尾轮），再判空转/blocker，最后 applyBudget 在 save 内统一跑。
            const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
            const result = applyTurn(accrued, facts, deps.options.emptyThreshold, now)
            blocked = result.blocked
            // spec §7：某轮未报 block → streak 归零；报了 block 则保留（由本层判定，model 只负责归零）。
            return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
          })
          // 只有成功结束才续跑：failed 保守跳过，避免在报错时形成续跑循环。
          if (event.type !== "session.execution.succeeded") return
          if (blocked) return
          // 后台任务在跑 → 本轮不续跑；宿主完成通知会唤醒会话（spec §4.5）。
          if ((pendingBackground.get(sessionID)?.size ?? 0) > 0) return
          const goal = await deps.repo.load(sessionID)
          if (!goal || goal.status !== "active") return
          // spec §12：agent 未知时保守跳过续跑，绝不回退成 "build" 放行受限 agent。
          const agent = agents.get(sessionID)
          if (agent === undefined) return
          const injected = await continuation.onIdle(sessionID, agent)
          if (injected) pendingAutomatic.add(sessionID)
          return
        }
```

替换为两个分支：

```ts
        case "session.execution.succeeded": {
          // 轮结束才结算；未开轮的结束事件（插件重启后接入）不结算、不续跑。
          if (!turnOpen.has(sessionID)) return
          turnOpen.delete(sessionID)
          const facts = tracker(sessionID).finish()
          const reportedBlocker = blockedThisTurn.get(sessionID) === true
          blockedThisTurn.set(sessionID, false)
          const usage = turnUsage.get(sessionID)
          turnUsage.delete(sessionID)
          let blocked = false
          await save(sessionID, (goal, now) => {
            // 先记账（整轮，含收尾轮），再判空转/blocker，最后 applyBudget 在 save 内统一跑。
            const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
            const result = applyTurn(accrued, facts, deps.options.emptyThreshold, now)
            blocked = result.blocked
            // spec §7：某轮未报 block → streak 归零；报了 block 则保留（由本层判定，model 只负责归零）。
            return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
          })
          if (blocked) return
          // 后台任务在跑 → 本轮不续跑；宿主完成通知会唤醒会话（spec §4.5）。
          if ((pendingBackground.get(sessionID)?.size ?? 0) > 0) return
          const goal = await deps.repo.load(sessionID)
          if (!goal || goal.status !== "active") return
          // spec §12：agent 未知时保守跳过续跑，绝不回退成 "build" 放行受限 agent。
          const agent = agents.get(sessionID)
          if (agent === undefined) return
          const injected = await continuation.onIdle(sessionID, agent)
          if (injected) pendingAutomatic.add(sessionID)
          return
        }

        case "session.execution.failed": {
          // 结算（仅当本插件看到过该轮开始）；failed 永不续跑，避免在报错时形成续跑循环。
          if (turnOpen.has(sessionID)) {
            turnOpen.delete(sessionID)
            const facts = tracker(sessionID).finish()
            const reportedBlocker = blockedThisTurn.get(sessionID) === true
            blockedThisTurn.set(sessionID, false)
            const usage = turnUsage.get(sessionID)
            turnUsage.delete(sessionID)
            await save(sessionID, (goal, now) => {
              const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
              const result = applyTurn(accrued, facts, deps.options.emptyThreshold, now)
              return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
            })
          }
          // 宿主信号 → 状态（spec §4.3/§4.4）：无论是否开轮都套用（插件重启后接入也要改状态）。
          const signal = hostSignal(data.error)
          if (!signal) return
          const before = await deps.repo.load(sessionID)
          if (!before) return
          await save(sessionID, (goal, now) => applyHostSignal(goal, now, signal))
          const after = await deps.repo.load(sessionID)
          if (after && after.status !== before.status) await notify(sessionID, signalNotice(after.status, signal.message))
          return
        }
```

- [ ] **Step 5: 改 `src/server.ts`**

把 `const router = createEventRouter(deps, continuation)` 改为：

```ts
    const router = createEventRouter(deps, continuation, notify)
```

- [ ] **Step 6: 跑测试 + 类型检查**

Run: `bun test src/host/events.test.ts && bunx tsc --noEmit`
Expected: PASS；tsc 0 错。

- [ ] **Step 7: 全量测试**

Run: `bun test`
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/host/notice.ts src/host/events.ts src/host/events.test.ts src/server.ts
git commit -m "feat(host): failed 轮套用宿主信号改状态并发纯回执"
```

---

## Task 5: `/goal-status` 展示与命令描述（`host/commands.ts` + `server.ts`）

**Files:**
- Modify: `src/host/commands.ts:104-110`
- Modify: `src/host/commands.test.ts`
- Modify: `src/server.ts:85`

**Interfaces:**
- Consumes: Task 1 的 `Goal.lastError`。

- [ ] **Step 1: 加失败测试**

在 `src/host/commands.test.ts` 的 `describe("createCommandHandlers", …)` 内加：

```ts
  test("status line surfaces the last host error", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit reached", at: 1 },
    })
    await handlers.status("ses_1")
    expect(notices[0]).toContain("usage-limited")
    expect(notices[0]).toContain("weekly usage limit reached")
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/host/commands.test.ts`
Expected: FAIL —— status 行未包含 `lastError` 文案。

- [ ] **Step 3: 改 `src/host/commands.ts` 的 `statusLine`**

```ts
function statusLine(goal: Goal): string {
  const budget = goal.tokenBudget === undefined ? "no budget" : `budget ${goal.tokenBudget}`
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : undefined
  const detail = usage ? ` (cacheRead ${usage.cacheRead} · new work ${newWorkOf(usage)})` : ""
  const lastError = goal.lastError ? `; last error: ${goal.lastError.message || goal.lastError.type}` : ""
  return `Goal (${goal.status}) — tokens ${goal.tokensUsed} / ${budget}${detail}; ${goal.timeUsedSeconds}s${lastError}. Objective: ${goal.objective}`
}
```

- [ ] **Step 4: 改 `src/server.ts` 的 resume 命令描述**

```ts
        description: "Resume a paused, blocked, budget-limited, or usage-limited goal.",
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun test src/host/commands.test.ts && bunx tsc --noEmit`
Expected: PASS；tsc 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/host/commands.ts src/host/commands.test.ts src/server.ts
git commit -m "feat(host): /goal-status 展示 lastError，resume 描述补 usage-limited"
```

---

## Task 6: 文档回填

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/opencode/known-issues.md`
- Modify: `docs/superpowers/specs/2026-09-25-opencode-goal-v2-host-signals-design.md`（仅在实现与 spec 有偏差时）

- [ ] **Step 1: 在 `CHANGELOG.md` 的 `[Unreleased]` 段加条目**

```markdown
- 宿主终态信号 → 状态：配额/限流（`provider.quota`）→ `usage-limited`；`provider.auth` / `provider.content-filter` / `provider.invalid-request` → `blocked`。记 `lastError`、发纯回执、支持 `/goal-resume`。（V2 子项目 3）
```

- [ ] **Step 2: 更新 `docs/opencode/known-issues.md` 的「V2 待办」段**

在段末追加一行：

```markdown
> 「宿主信号 → 状态（usage-limited / 宿主终态错误 → blocked）」已于 V2 子项目 3 实现（见 `CHANGELOG.md` 的 `[Unreleased]`），条目移出。
```

- [ ] **Step 3: 若实现与 spec 有偏差，同步 spec 并追加 §10 修订记录**

- [ ] **Step 4: 提交**

```bash
git add CHANGELOG.md docs/opencode/known-issues.md
git commit -m "docs: 回填宿主信号→状态（CHANGELOG / known-issues）"
```

---

## Task 7: 真机核对（用户协助，可能延后）

**Files:** 无（只读核对）

**说明**：spec §3.6/§7 要求真机核对 `session.execution.failed` 的 `data.error` 形状与「订阅不重放」。需一个真实会话。

- [ ] **Step 1: 制造一次可预期的终态失败**

在一个专用会话里，把模型指向不存在的路由（→ 预期 `provider.no-route`，被排除），跑一轮触发 `session.execution.failed`。

- [ ] **Step 2: 核对**

- 插件确实收到该事件（`/goal-debug events` 出现 `session.execution.failed`，decision = `allow`）；
- 目标状态**未变**（no-route 被排除）；
- 若可行，用无效 API key 触发 `provider.auth` → 状态翻 `blocked` 且 `/goal-status` 显示 `lastError`。

- [ ] **Step 3: 核对订阅语义**

插件重启后不重放旧 `failed`（订阅为实时流）。

- [ ] **Step 4: 记录结果**

把结果写进 `docs/opencode/smoke-checklist.md`（新增一节），或回报给主会话。

---

## Self-Review

**Spec coverage（逐节核对）：**

| Spec 节 | 覆盖任务 |
| --- | --- |
| §4.1 映射模块 | Task 1 |
| §4.2 状态与字段 | Task 1（types）、Task 3（持久化/展示） |
| §4.3 转移与优先级 | Task 1（转移）、Task 2（resume/预算） |
| §4.4 事件接线 + 回执 | Task 4 |
| §4.5 展示 | Task 3（view）、Task 5（statusLine） |
| §4.6 resume | Task 2 |
| §4.7 debug | 无需改动（spec 已说明） |
| §7 测试 | 各任务的测试步骤 + Task 7 |
| §2 非目标 | Global Constraints 明确禁止 |
| §3 宿主事实 | 实现无需代码，仅指导（已在 spec 核实） |

**Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency：**
- `HostSignal.status` 用字面量 `"usage-limited" | "blocked"`，与 `GoalStatus` 新增值一致。
- `applyHostSignal(goal, now, signal)` 三参签名在 Task 1 定义、Task 4 使用一致。
- `createEventRouter(deps, continuation, notify)` 三参签名在 Task 4 定义；**全部调用点**都要改：`server.ts`、`events.test.ts` 的 `makeRouter` 与 2 处直连调用、`debug.test.ts:42`（Task 4 Step 1 已列明）。
- `signalNotice(status, message)` 两参在 Task 4 定义/使用一致。
- `GoalLastError` 在 Task 1 定义，Task 3 的 `GoalView.lastError: GoalLastError | null` 与 `isLastError` 校验字段（type/message/at）一致。

**已知取舍：** Task 7 无法在子代理内自动完成（需真实会话/配额），按子项目 2 的先例交用户协助。
