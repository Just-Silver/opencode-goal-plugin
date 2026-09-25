# 后台任务 deferral 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本会话有后台任务（后台 shell / 后台 subagent）在跑时，轮末**不**自动续跑；任务结束（宿主完成通知）后恢复续跑。

**Architecture:** 在 `src/host/events.ts` 的事件路由里维护一个**纯内存** `pendingBackground: Map<sessionID, Set<key>>`。起信号 = `session.tool.success` 的结果 metadata（`status:"running"` + `shellID`/`sessionID`）；止信号 = `session.inbox.enqueued` 的 `item.payload.metadata`（`source:"shell"|"subagent"`），并带「最外层标签」文本兜底。续跑前加一道「pending 非空则跳过」门控。另加 `recentlyCompleted` 乱序护栏，防瞬时任务的完成通知先于起信号到达。宿主「完成即唤醒」保证（`synthetic` 默认 `resume:true`）是安全底座，故不做超时放行。

**Tech Stack:** TypeScript（Bun 运行时 / `bun:test`）、OpenCode V2 插件 API（`@opencode/plugin@2.0.16`）、Bun 冒烟脚本（`scripts/smoke-api.mjs`）。

**Spec:** `docs/superpowers/specs/2026-09-25-opencode-goal-v2-background-deferral-design.md`（执行者请与 spec 一起读；本计划的每个断言都从 spec 推导）

## Global Constraints

- 只支持 **OpenCode V2**；运行时只 import 相对路径模块与宿主提供的类型，**不引入任何第三方运行时依赖**。
- 仓库内**不写机器绝对路径**。
- 插件自身**不 spawn 任何子进程**（无 `child_process` / `spawn` / `exec` / `fork`）。
- 调试输出走 `session.synthetic` 的 `description`，TUI 是**纯文本渲染**：调试文本不得含 Markdown（`###`、`|`、反引号）。
- **不做**：配置项（`defer_while_tasks_active` / `max_task_block_seconds`）、超时放行、重启回放、落 KV。
- 记账口径不变：`input+output+reasoning+cacheRead+cacheWrite`。
- 中文提交信息；命令面只有「多命令」一种。
- 关键测试命令：`bun test`、`bunx tsc --noEmit`。

---

### Task 1: 起信号 —— pending 集合 + `session.tool.success` 入队 + 门控

建立内存 `pendingBackground`，识别后台任务的「起」（工具结果 metadata `status:"running"`），并在轮末续跑前门控。完成后即可保证「后台 shell 在跑时**不**续跑」（止信号在 Task 2）。

**Files:**
- Modify: `src/host/events.ts`
- Test: `src/host/events.test.ts`

**Interfaces:**
- Consumes: 既有 `EventRouter`、`GoalDeps`、`Continuation`。
- Produces:
  - `DebugSessionState` 新增字段 `pendingBackground: number`（`src/host/events.ts`）。
  - 事件路由处理 `session.tool.success`；`TRACKED_TYPES` 含 `session.tool.success`、`session.inbox.enqueued`。
  - `EventRouter.diagnostics().sessions[].pendingBackground` 可用。

- [ ] **Step 1: 真机核对 metadata 形状（spec 要求，先于逻辑实现）**

先把两条事件加进调试环（本步只加类型，不改逻辑），然后真机观察真实 metadata。在 `src/host/events.ts` 的 `TRACKED_TYPES` 里，于**既有的** `"session.tool.called",` 之后加入一行 `"session.tool.success",`；于既有的 `"session.deleted",` 之后加入一行 `"session.inbox.enqueued",`（**不要重复插入既有行**）。

真机命令（在专门冒烟会话上；会消耗模型额度）：

```bash
bun scripts/smoke-api.mjs --session <sid> --scenario basic
```

随后在同一会话里手动触发一次后台任务，并用 `/goal-debug events` 观察事件类型是否出现 `session.tool.success` / `session.inbox.enqueued`。

**判据（务必对照真实输出，不要用假形状）：**
- `session.tool.success` 的 `data.metadata` 在后台 shell 下含 `status:"running"` + `shellID`；后台 subagent 下含 `status:"running"` + `sessionID`。
- `session.inbox.enqueued` 的 `data.item.payload.metadata` 在完成通知里含 `source:"shell"`+`shellID` 或 `source:"subagent"`+`childID`。

若真实形状与 spec §3.2 不符：**停止实现，先回报差异**（本仓库曾栽在「假形状遮住真 bug」，见 `docs/opencode/plugin-dev-gotchas.md` §8.3）。若本机无法真机执行，**明确告知用户**并在 Task 5 冒烟时补核。

- [ ] **Step 2: 扩展测试夹具，并写失败测试**

在 `src/host/events.test.ts` 的 `makeRouter` 返回值里补 `diagnostics`，并在 `executionFailed` 辅助函数下方加 `toolSuccess` 辅助函数：

```ts
function makeRouter(deps: GoalDeps, continuation: Continuation) {
  const inner = createEventRouter(deps, continuation)
  return {
    handle: (event: { type: string; data?: Record<string, unknown>; location?: { directory?: unknown } }) =>
      inner.handle({ location: { directory: deps.locationDirectory }, ...event }),
    pendingUsage: (sessionID: string) => inner.pendingUsage(sessionID),
    diagnostics: () => inner.diagnostics(),
  }
}
```

```ts
const toolSuccess = (sessionID: string, metadata: Record<string, unknown>) => ({
  type: "session.tool.success",
  data: { sessionID, metadata },
})
```

在 `describe("createEventRouter", ...)` 内追加三个测试：

```ts
  test("a running background shell defers continuation until it completes", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_1" }))
    await router.handle(executionSucceeded("ses_1"))
    // 后台任务在跑 → 不续跑
    expect(prompts).toEqual([])
  })

  test("a foreground subagent result does not enter pending", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    // 前台 subagent：结果 metadata 是 completed（不是 running）→ 不计入
    await router.handle(toolSuccess("ses_1", { status: "completed", sessionID: "ses_fg" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })
```

> 注：「前台 subagent 不计入」是一条**回归护栏**：未实现 pending 逻辑时它也已通过（`prompts` 本就为 `["ses_1"]`），实现后仍须通过。它用于防止把前台结果误计入 pending，**不是**红-绿测试。

```ts
  test("diagnostics reports the pending background count", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_1" }))
    const state = router.diagnostics().sessions.find((item) => item.sessionID === "ses_1")
    expect(state?.pendingBackground).toBe(1)
  })
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `bun test src/host/events.test.ts`
Expected: FAIL —— `pendingBackground` 未定义 / 后台 shell 测试里 `prompts` 不为空。

- [ ] **Step 4: 实现 —— 状态、辅助函数、事件分支、门控、诊断**

在 `src/host/events.ts` 做以下改动。

4a. `DebugSessionState` 加字段（放在 `blockedThisTurn` 之后）：

```ts
export interface DebugSessionState {
  readonly sessionID: string
  readonly turnOpen: boolean
  readonly agent?: string
  readonly sessionDirectory: string | null | undefined
  readonly pendingAutomatic: boolean
  readonly blockedThisTurn: boolean
  /** 本会话在跑的后台任务数（后台 shell / 后台 subagent）。 */
  readonly pendingBackground: number
}
```

4b. 在 `turnUsage` 声明之后加状态与辅助函数：

```ts
  const turnUsage = new Map<string, TurnUsage>()
  /**
   * 本会话正在跑的后台任务 key（后台 shell = `shellID`；后台 subagent = 子会话 id）。
   * 非空 → 该会话轮末不自动续跑，等宿主完成通知唤醒（spec §4.1/§4.5）。
   */
  const pendingBackground = new Map<string, Set<string>>()
```

4c. 在 `tracker` 辅助函数之后加：

```ts
  /** 后台任务「起」：加入 pending（spec §4.2）。 */
  const addPendingBackground = (sessionID: string, key: string): void => {
    const keys = pendingBackground.get(sessionID) ?? new Set<string>()
    keys.add(key)
    pendingBackground.set(sessionID, keys)
  }
```

4d. 在 `switch` 的 `session.tool.called` 分支之后加：

```ts
        case "session.tool.success": {
          // 后台任务的「起」：仅当结果 metadata 标 `running`（前台结果为 `completed`/缺失 → 排除）。
          const metadata = (data.metadata ?? {}) as Record<string, unknown>
          if (metadata.status !== "running") return
          if (typeof metadata.shellID === "string") addPendingBackground(sessionID, metadata.shellID)
          else if (typeof metadata.sessionID === "string") addPendingBackground(sessionID, metadata.sessionID)
          return
        }
```

4e. 在 `session.execution.succeeded` 分支的 `if (blocked) return` 之后加门控：

```ts
          if (blocked) return
          // 后台任务在跑 → 本轮不续跑；宿主完成通知会唤醒会话（spec §4.5）。
          if ((pendingBackground.get(sessionID)?.size ?? 0) > 0) return
```

> §4.5 的「在 debug 记为 defer」以 Task 4 的 `pending background` 计数作为可观测证据（defer 发生时该计数 > 0）；不单独新增 defer 标记。

4f. `diagnostics()` 里把 pending 会话纳入 id 集合，并在每个会话上输出计数：

```ts
    diagnostics() {
      const ids = new Set<string>([
        ...agents.keys(),
        ...sessionLocations.keys(),
        ...trackers.keys(),
        ...turnOpen,
        ...pendingBackground.keys(),
      ])
      return {
        events: [...debugEvents],
        sessions: [...ids].map((sessionID) => ({
          sessionID,
          turnOpen: turnOpen.has(sessionID),
          ...(agents.has(sessionID) ? { agent: agents.get(sessionID) } : {}),
          sessionDirectory: sessionLocations.get(sessionID),
          pendingAutomatic: pendingAutomatic.has(sessionID),
          blockedThisTurn: blockedThisTurn.get(sessionID) === true,
          pendingBackground: pendingBackground.get(sessionID)?.size ?? 0,
        })),
      }
    },
```

- [ ] **Step 5: 运行测试与类型检查，确认通过**

Run: `bun test src/host/events.test.ts && bunx tsc --noEmit`
Expected: PASS，且 0 类型错误。

- [ ] **Step 6: 提交**

```bash
git add src/host/events.ts src/host/events.test.ts
git commit -m "feat(host): 后台任务起信号入 pending 并在轮末门控续跑"
```

---

### Task 2: 止信号 —— `session.inbox.enqueued` 出队 + 文本兜底 + 乱序护栏

识别后台任务的「止」（宿主完成通知），从 pending 移除并记录 `recentlyCompleted`；补文本兜底与乱序护栏。完成后「后台任务结束时恢复续跑」。

**Files:**
- Modify: `src/host/events.ts`
- Test: `src/host/events.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `pendingBackground`、`addPendingBackground`。
- Produces: 事件路由处理 `session.inbox.enqueued`（仅 `item.type === "synthetic"`）；`completeBackground(key)`、`completionKeyFromMetadata`、`completionKeyFromText`。

- [ ] **Step 1: 写失败测试**

在 `src/host/events.test.ts` 的 `toolSuccess` 辅助函数下方加 `inboxEnqueued` 辅助函数：

```ts
const inboxEnqueued = (sessionID: string, metadata: Record<string, unknown>, text?: string) => ({
  type: "session.inbox.enqueued",
  data: {
    sessionID,
    item: { type: "synthetic", payload: { metadata, ...(text === undefined ? {} : { text }) } },
  },
})
```

在 `describe` 内追加三个测试：

```ts
  test("a background subagent's completion clears pending via the text fallback", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
    // metadata 无 source（形状漂移）→ 走最外层标签文本兜底
    await router.handle(
      inboxEnqueued("ses_1", {}, `<subagent sessionID="ses_child" state="completed" description="x">\ndone\n</subagent>`),
    )
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })

  test("a user shell completion notification does not clear a background pending", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_bg" }))
    await router.handle(executionSucceeded("ses_1"))
    // 用户 `!命令` 的完成通知：shellID 不在 pending → 只按 key 移除，不得清空
    await router.handle(inboxEnqueued("ses_1", { source: "shell", shellID: "sh_user" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })

  test("a completion notification arriving before the start signal still suppresses the pending", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    // 瞬时任务：完成通知先到（key 尚未进 pending）
    await router.handle(inboxEnqueued("ses_1", { source: "shell", shellID: "sh_fast" }))
    // 起信号后到 → 乱序护栏应拦住，不再入 pending
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_fast" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test src/host/events.test.ts`
Expected: FAIL —— 前两个测试的 `prompts` 为空（止信号未实现）；第三个测试 `prompts` 为空（乱序护栏未实现）。

- [ ] **Step 3: 实现 —— 止信号、文本兜底、乱序护栏**

在 `src/host/events.ts` 的 `pendingBackground` 声明之后加：

```ts
  /**
   * 已完成的后台任务 key → 完成时刻（`deps.now()`）。用于「完成通知先于起信号到达」的乱序护栏：
   * 瞬时任务（如 `echo`）的完成通知可能先于 `session.tool.success` 到达，若不加护栏会在起信号时
   * 又被加回 pending → 永久 defer。key 全局唯一（shell ID / 子会话 id），不会误挡合法的重新开始。
   */
  const recentlyCompleted = new Map<string, number>()
  const RECENTLY_COMPLETED_TTL_MS = 30_000
```

把 Task 1 的 `addPendingBackground` 替换为带护栏版本：

```ts
  /** 后台任务「起」：加入 pending；若完成通知已先到（乱序护栏）则不加（spec §4.2）。 */
  const addPendingBackground = (sessionID: string, key: string): void => {
    const at = recentlyCompleted.get(key)
    if (at !== undefined && deps.now() - at <= RECENTLY_COMPLETED_TTL_MS) return
    const keys = pendingBackground.get(sessionID) ?? new Set<string>()
    keys.add(key)
    pendingBackground.set(sessionID, keys)
  }

  /** 只从 pending 移除 key（不记 `recentlyCompleted`）；用于会话删除等清理路径。 */
  const dropPendingKey = (key: string): void => {
    for (const [sid, keys] of pendingBackground) {
      keys.delete(key)
      if (keys.size === 0) pendingBackground.delete(sid)
    }
  }

  /** 后台任务「止」：记录完成时刻（无论是否命中 pending），并从所有会话移除该 key（spec §4.3）。 */
  const completeBackground = (key: string): void => {
    const now = deps.now()
    recentlyCompleted.set(key, now)
    for (const [k, at] of recentlyCompleted) if (now - at > RECENTLY_COMPLETED_TTL_MS) recentlyCompleted.delete(k)
    dropPendingKey(key)
  }

  /** 从完成通知的 metadata 取 key（主路径）。 */
  const completionKeyFromMetadata = (metadata: Record<string, unknown>): string | undefined => {
    if (metadata.source === "shell" && typeof metadata.shellID === "string") return metadata.shellID
    if (metadata.source === "subagent" && typeof metadata.childID === "string") return metadata.childID
    return undefined
  }

  /** 文本兜底：只认通知**最外层**标签，避免正文里的同名标签误伤（spec §4.3）。 */
  const completionKeyFromText = (text: unknown): string | undefined => {
    if (typeof text !== "string") return undefined
    const shell = /^\s*<shell\b[^>]*\bid="([^"]+)"/.exec(text)
    if (shell) return shell[1]
    const subagent = /^\s*<subagent\b[^>]*\bsessionID="([^"]+)"/.exec(text)
    if (subagent) return subagent[1]
    return undefined
  }
```

> 已知边界：真实 shell 通知文本的 `id` 取 `jobID ?? shellID`（宿主 `shell/result.ts`），pending key 用 `shellID`。后台 shell 路径下 `jobs.start({ id: info.id })` 使 `jobID === shellID`，故一致；仅当 metadata 缺失**且** `jobID !== shellID` 时文本兜底可能落空（极低概率）。metadata 是主路径。

在 `switch` 的 `session.tool.success` 分支之后加：

```ts
        case "session.inbox.enqueued": {
          // 后台任务的「止」：宿主完成通知走 Session.synthetic → admit → InboxEnqueued（spec §3.2/§4.3）。
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type !== "synthetic") return
          const payload = (item.payload ?? {}) as Record<string, unknown>
          const key =
            completionKeyFromMetadata((payload.metadata ?? {}) as Record<string, unknown>) ??
            completionKeyFromText(payload.text)
          if (key === undefined) return
          completeBackground(key)
          return
        }
```

- [ ] **Step 4: 运行测试与类型检查，确认通过**

Run: `bun test src/host/events.test.ts && bunx tsc --noEmit`
Expected: PASS，且 0 类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/host/events.ts src/host/events.test.ts
git commit -m "feat(host): 后台完成通知出 pending，含文本兜底与乱序护栏"
```

---

### Task 3: 清理 —— 多任务、`session.deleted`、`interrupted` 保留

补齐生命周期：多任务需全部完成才续跑；删会话清理 pending（含子会话 key）；中断**保留** pending。

**Files:**
- Modify: `src/host/events.ts`
- Test: `src/host/events.test.ts`

**Interfaces:**
- Consumes: Task 1/2 的 `pendingBackground`、`dropPendingKey`、`inboxEnqueued`、`toolSuccess`。
- Produces: `session.deleted` 清理 pending；`session.execution.interrupted` 不清 pending。

- [ ] **Step 1: 写失败测试**

在 `describe` 内追加三个测试：

```ts
  test("continuation resumes only after every background task completes", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_1" }))
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
    // 移出一个 → 仍不续跑
    await router.handle(inboxEnqueued("ses_1", { source: "shell", shellID: "sh_1" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
    // 全部移出 → 续跑
    await router.handle(inboxEnqueued("ses_1", { source: "subagent", childID: "ses_child" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })

  test("deleting a background child session drops the parent's pending", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
    // 子会话被删 → 父会话里以该 id 为 key 的 pending 被移除
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_child" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })

  test("an interruption keeps the pending background tasks", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_1" }))
    await router.handle({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    // 中断后目标转 paused；用户 resume 时后台任务仍在跑 → 仍应 defer
    const paused = (await deps.repo.load("ses_1"))!
    await deps.repo.save("ses_1", { ...paused, status: "active" })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test src/host/events.test.ts`
Expected: FAIL —— 「deleting a background child session」的 `prompts` 为空（`session.deleted` 未清 pending）。另两个可能已通过（属回归保护）。

- [ ] **Step 3: 实现 —— 删除清理 + 中断保留注释**

在 `src/host/events.ts` 的 `session.execution.interrupted` 分支加注释（明确**不**清 pending）：

```ts
        case "session.execution.interrupted": {
          // spec §8：中断（Esc / 关闭 / 超时）→ paused；丢弃未完成轮的残留状态，恢复后默认不自动续。
          // 注意：**不**清 pendingBackground —— 后台 job 独立于 drain，中断取消不到后台任务，
          // 其完成通知仍会到达并清 pending（spec §4.4）。
```

在 `session.deleted` 分支的 `sessionLocations.delete(sessionID)` 之后加：

```ts
          sessionLocations.delete(sessionID)
          // 后台 subagent 的子会话被删 → 从所有会话 pending 移除该 key；并清本会话自身 pending（spec §4.4）。
          dropPendingKey(sessionID)
          pendingBackground.delete(sessionID)
```

- [ ] **Step 4: 运行测试与类型检查，确认通过**

Run: `bun test src/host/events.test.ts && bunx tsc --noEmit`
Expected: PASS，且 0 类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/host/events.ts src/host/events.test.ts
git commit -m "feat(host): 后台 pending 的多任务与删会话/中断生命周期"
```

---

### Task 4: `/goal-debug state` 展示 pending 计数

把 `pendingBackground` 计数渲染进调试输出，便于真机排障。

**Files:**
- Modify: `src/host/debug.ts`
- Test: `src/host/debug.test.ts`

**Interfaces:**
- Consumes: `DebugSessionState.pendingBackground`（Task 1）。
- Produces: `renderState` 输出一行 `pending background: <n>`。

- [ ] **Step 1: 写失败测试**

在 `src/host/debug.test.ts` 的 `describe("createDebug", ...)` 内追加：

```ts
  test("state reports the pending background count", async () => {
    const { debug, router } = makeDebug(makeDeps())
    await router.handle({ type: "session.tool.success", data: { sessionID: "ses_1", metadata: { status: "running", shellID: "sh_1" } } })
    const text = await debug.render("state", "ses_1")
    expect(text).toContain("pending background: 1")
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test src/host/debug.test.ts`
Expected: FAIL —— 输出里没有 `pending background:`。

- [ ] **Step 3: 实现**

在 `src/host/debug.ts` 的 `renderState` 里，`pending automatic` 行之后加：

```ts
    `pending automatic: ${state === undefined ? "-" : state.pendingAutomatic}`,
    `pending background: ${state === undefined ? "-" : state.pendingBackground}`,
```

- [ ] **Step 4: 运行测试与类型检查，确认通过**

Run: `bun test src/host/debug.test.ts && bunx tsc --noEmit`
Expected: PASS，且 0 类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/host/debug.ts src/host/debug.test.ts
git commit -m "feat(debug): /goal-debug state 展示后台 pending 计数"
```

---

### Task 5: 冒烟 `background` 场景

在 `scripts/smoke-api.mjs` 增加真机场景：后台 shell 在跑期间**不**续跑，完成后恢复。

**Files:**
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `ctx.events`、`ctx.receipts`、`ctx.waitStatus`、`sendGoal`、`control`（既有）。
- Produces: `SCENARIOS.background`。

- [ ] **Step 1: 加场景**

在 `scripts/smoke-api.mjs` 的 `SCENARIOS` 对象里，`continuation` 场景之后插入：

```js
  // 后台任务：后台 shell 在跑时不自动续跑，完成后才续（依赖模型配合使用 background: true）
  background: {
    title: "后台任务：后台 shell 运行期间不自动续跑，完成后恢复",
    run: async (ctx) => {
      await ctx.clearGoal()
      const m = ctx.events.mark()
      await sendGoal(
        ctx.sid,
        '调用 bash 工具（参数 background: true）执行这条命令：sleep 30; echo done —— 后台启动后立刻结束本轮、不要等待、不要轮询。目标：等这条命令完成后回复 完成。',
      )
      const active = await ctx.waitStatus("active", 90000)
      check(active, "目标应进入 active")
      // 后台任务在跑的窗口内：不得出现 auto-continue 回执
      await sleep(15000)
      const during = ctx.receipts(m).filter((d) => /Goal auto-continue/i.test(d)).length
      ctx.log(`后台运行期间 auto-continue 回执=${during}`)
      check(during === 0, `后台任务运行期间不应自动续跑，实际 ${during}`)
      // 完成后宿主唤醒 → 恢复续跑
      const done = await ctx.waitStatus(["complete", "blocked", "budget-limited"], 240000)
      check(done, "应到达终态")
      const after = ctx.receipts(m).filter((d) => /Goal auto-continue/i.test(d)).length
      ctx.log(`完成后 auto-continue 回执=${after}`)
      check(after >= 1, `后台完成后应至少 1 条 auto-continue，实际 ${after}`)
      await control(ctx.sid, "clear")
      await sleep(1500)
    },
  },
```

- [ ] **Step 2: 语法/加载自检**

Run: `bun scripts/smoke-api.mjs --list`
Expected: 列表里出现 `background`。

- [ ] **Step 3: 真机执行（在专门冒烟会话上；会消耗模型额度）**

Run: `bun scripts/smoke-api.mjs --session <sid> --scenario background`
Expected: PASS。若模型未按 `background: true` 使用后台（单轮即完成），场景可能 FAIL —— 这是**模型不配合**，需换确定性模型或在 TUI 手动验证；在 `smoke-checklist.md` 记录实况。

- [ ] **Step 4: 提交**

```bash
git add scripts/smoke-api.mjs
git commit -m "test(smoke): 新增 background 场景（后台任务期间不续跑）"
```

---

### Task 6: 文档回填

把「V2 待办」条目移出、更新 CHANGELOG 与冒烟清单。

**Files:**
- Modify: `docs/opencode/known-issues.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/opencode/smoke-checklist.md`

- [ ] **Step 1: 移除 known-issues 的 V2 待办条目**

在 `docs/opencode/known-issues.md` 里，删除从 `### [ ] 后台任务（background subagent / shell）运行期间不应自动续跑` 到其 `**验证**：冒烟加 background 场景……` 结尾的整段，并把该节标题行下的引言改为：

```markdown
## V2 待办（V1 收尾时确认推迟）

> 2026-09-25 V1 收尾：以下项**确认推迟**，移交 V2。（原「0.1.1 发布推迟」一项已于 2026-09-25 完成发布，见 `CHANGELOG.md` 的 `[0.1.1]` 与 GitHub Release `v0.1.1`。）
> 「后台任务运行期间不自动续跑」已于 V2 子项目 2 实现（见 `CHANGELOG.md` 的 `[Unreleased]`），条目移出。
```

- [ ] **Step 2: 更新 CHANGELOG**

把 `CHANGELOG.md` 里**空的** `## [Unreleased]` 一节替换为：

```markdown
## [Unreleased]

### Added

- **后台任务 deferral**：后台 shell / 后台 subagent 运行期间，轮末**不再**自动续跑；宿主完成通知（`session.inbox.enqueued`）到达后恢复。起/止信号取自工具结果 metadata（`status:"running"`）与完成通知 metadata（`source:"shell"|"subagent"`），并带最外层标签文本兜底与乱序护栏。纯内存、不落 KV、不加配置项、不做超时放行（依赖宿主「完成即唤醒」保证）。
```

- [ ] **Step 3: 更新冒烟清单**

在 `docs/opencode/smoke-checklist.md` §5 的场景列表里追加 `background`：

```markdown
`commands` / `basic` / `block` / `budget` / `interrupt` / `continuation` / `background` / `conflict` / `truncate` / `kv-cleanup` / `reconcile` / `empty` / `compaction`。
```

- [ ] **Step 4: 提交**

```bash
git add docs/opencode/known-issues.md CHANGELOG.md docs/opencode/smoke-checklist.md
git commit -m "docs: 回填后台 deferral（CHANGELOG / 冒烟清单 / 移出已知问题）"
```

---

## 收尾验证（全部任务完成后）

- [ ] `bun test` 全绿（在 Task 1 前基线 187 pass；本计划新增约 10 条）。
- [ ] `bunx tsc --noEmit` 0 错。
- [ ] `bun scripts/smoke-api.mjs --session <sid> --scenario continuation,background` 真机通过（`continuation` 的 `cont <= succeeded` 护栏不回归）。
- [ ] `git push origin main`。

## 自审记录

- **spec 覆盖**：§3.2 起信号 → Task 1；止信号 → Task 2；§3.3 安全底座（不超时放行）→ Global Constraints；§4.1 内存 pending → Task 1；§4.2 起 + 乱序护栏 → Task 1/2；§4.3 止 + 文本兜底 + 不 clear-all → Task 2；§4.4 清理（deleted/interrupted）→ Task 3；§4.5 门控（defer 以 `pending background` 计数为可观测证据）→ Task 1/4；§4.6 debug → Task 4；§7 测试 → Task 1-4；§7 冒烟 → Task 5；文档 → Task 6。
- **类型一致性**：`pendingBackground` / `recentlyCompleted` / `addPendingBackground` / `dropPendingKey` / `completeBackground` / `completionKeyFromMetadata` / `completionKeyFromText` / `RECENTLY_COMPLETED_TTL_MS` 全计划统一；`DebugSessionState.pendingBackground: number` 在 Task 1 定义、Task 4 消费。
- **占位符**：无 TODO/TBD；每个代码步骤含完整代码。
- **已知模型依赖**：Task 5 冒烟与「空转」场景同属模型依赖项，真机可能需换确定性模型。