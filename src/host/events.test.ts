import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { complete, createGoal, pause } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createContinuation, type Continuation } from "./continuation"
import { createEventRouter } from "./events"
import type { GoalDeps } from "./deps"

function memoryStorage(): StorageLike {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan({ prefix }) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

const OWN = "own"

function makeDeps(): GoalDeps {
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS, blockedThreshold: 3, emptyThreshold: 3 },
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: OWN,
    sessionDirectory: async () => OWN,
  }
}

/**
 * 模拟真实事件流：带 location 的事件标上本 location。事件自带 location 时以它为准
 * （`...event` 在 `location` 之后，所以显式传入的 location 会覆盖），便于测试跨 location 忽略。
 */
function makeRouter(deps: GoalDeps, continuation: Continuation) {
  const inner = createEventRouter(deps, continuation)
  return {
    handle: (event: { type: string; data?: Record<string, unknown>; location?: { directory?: unknown } }) =>
      inner.handle({ location: { directory: deps.locationDirectory }, ...event }),
    pendingUsage: (sessionID: string) => inner.pendingUsage(sessionID),
    diagnostics: () => inner.diagnostics(),
  }
}

const executionStarted = (sessionID: string) => ({ type: "session.execution.started", data: { sessionID } })
const executionSucceeded = (sessionID: string) => ({ type: "session.execution.succeeded", data: { sessionID } })
const executionFailed = (sessionID: string) => ({ type: "session.execution.failed", data: { sessionID } })
const toolSuccess = (sessionID: string, metadata: Record<string, unknown>) => ({
  type: "session.tool.success",
  data: { sessionID, metadata },
})
const inboxEnqueued = (sessionID: string, metadata: Record<string, unknown>, text?: string) => ({
  type: "session.inbox.enqueued",
  data: {
    sessionID,
    item: { type: "synthetic", payload: { metadata, ...(text === undefined ? {} : { text }) } },
  },
})

describe("createEventRouter", () => {
  test("accrues tokens and continues once on execution end", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (_sessionID, agentId) => {
        prompts.push(agentId)
        return true
      },
    })

    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle({ type: "session.text.ended", data: { sessionID: "ses_1", text: "working" } })
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    await router.handle(executionSucceeded("ses_1"))

    // 口径 = 真实处理量：100 + 10 + 5 + 50(cacheRead) + 2(cacheWrite) = 167
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(167)
    expect(prompts).toEqual(["build"])
  })

  test("counts the whole turn, including steps after the goal completes", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    // 第 1 步：目标还 active
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    // 模型在这一轮里 complete（工具层直接落盘，状态中途翻转）
    await deps.repo.save("ses_1", complete((await deps.repo.load("ses_1"))!, 1000))
    // 第 2 步：状态已是 complete —— 旧实现会漏掉这一步的 token
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 1000, output: 20, reasoning: 0, cache: { read: 500, write: 0 } } },
    })
    await router.handle(executionSucceeded("ses_1"))

    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("complete")
    expect(goal?.tokensUsed).toBe(167 + 1520)
  })

  test("exposes the in-flight usage while the turn is open, and clears it at turn end", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    expect(router.pendingUsage("ses_1")?.tokens).toEqual({
      input: 100,
      output: 10,
      reasoning: 5,
      cacheRead: 50,
      cacheWrite: 2,
    })
    await router.handle(executionSucceeded("ses_1"))
    expect(router.pendingUsage("ses_1")).toBeUndefined()
  })

  test("seeds touched at turn start, so a mid-turn external pause still counts", async () => {
    // 轮首 active → 立刻播种 touched；否则若状态在首个 step.ended 之前被外部改出 active
    // （例如用户中途 /goal pause），整轮 token 会被漏记。
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await deps.repo.save("ses_1", pause((await deps.repo.load("ses_1"))!, 1000))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    await router.handle(executionSucceeded("ses_1"))
    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("paused")
    expect(goal?.tokensUsed).toBe(11)
  })

  test("pendingUsage stays undefined for a turn that does not touch a goal", async () => {
    // complete 目标的普通轮：展示层不得叠加本轮 pending（否则会与轮末落盘值不一致）。
    const deps = makeDeps()
    await deps.repo.save("ses_1", complete(createGoal({ goalId: "g1", objective: "o", now: 0 }), 0))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 0 } } },
    })
    expect(router.pendingUsage("ses_1")).toBeUndefined()
    await router.handle(executionSucceeded("ses_1"))
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(0)
  })

  test("a duplicate execution.started does not reset the accumulator", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    const step = {
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    }
    await router.handle(executionStarted("ses_1"))
    await router.handle(step)
    await router.handle(executionStarted("ses_1")) // 重复 started：不得重启轮、不得清空已累积
    await router.handle(step)
    await router.handle(executionSucceeded("ses_1"))
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(22)
  })

  test("a turn with no active goal accrues nothing", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", complete(createGoal({ goalId: "g1", objective: "o", now: 0 }), 0))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    await router.handle(executionSucceeded("ses_1"))
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(0)
  })

  test("an interrupted turn still accrues its finished steps", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    await router.handle({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("paused")
    expect(goal?.tokensUsed).toBe(11)
  })

  test("writes the record once per turn, not once per step", async () => {
    let writes = 0
    const storage = memoryStorage()
    const counting: StorageLike = {
      ...storage,
      set: async (key, value) => {
        writes += 1
        await storage.set(key, value)
      },
    }
    const deps = { ...makeDeps(), repo: createRepository(counting) }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    for (let i = 0; i < 3; i++)
      await router.handle({
        type: "session.step.ended",
        data: { sessionID: "ses_1", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      })
    await router.handle(executionSucceeded("ses_1"))
    expect(writes).toBe(2) // 1 次建目标 + 1 次轮末落账（3 个 step 不写）
    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(6)
  })

  test("three consecutive empty automatic turns block the goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })

    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    // 用户轮：其结束注入第一轮续跑（automatic 标记置位）
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    for (let turn = 0; turn < 3; turn++) {
      await router.handle(executionStarted("ses_1"))
      await router.handle(executionSucceeded("ses_1"))
    }

    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("blocked")
    expect(goal?.emptyStreak).toBe(3)
    expect(injected).toBeLessThanOrEqual(3)
  })

  test("session.deleted removes the record", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_1" } })
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("session.deleted without a top-level location still removes the record", async () => {
    // 真机形状：session.deleted 的 payload 只有 sessionID，顶层**也没有** location
    // （宿主 schema：`packages/schema/src/session-event.ts` 里 Deleted 的 schema = Base = { sessionID }）。
    // 会话已删 → 归属回落查询必然失败 → 旧实现判成“不属于本实例”直接丢弃，记录永远清不掉。
    // 注意上面的测试用的是 makeRouter，它会给事件补上本实例的 location —— 正好抹掉了这个真实边界条件。
    const deps = { ...makeDeps(), sessionDirectory: async () => undefined }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_1" }, location: undefined })
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("an interruption pauses an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
  })

  test("a turn without a block report resets the blocker streak", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      blockerKey: "k",
      blockerStreak: 2,
    })
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle({ type: "session.text.ended", data: { sessionID: "ses_1", text: "moving on" } })
    await router.handle(executionSucceeded("ses_1"))
    const goal = await deps.repo.load("ses_1")
    expect(goal?.blockerStreak).toBe(0)
    expect(goal?.blockerKey).toBe("k")
  })

  test("a turn that reports a block keeps the streak", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      blockerKey: "k",
      blockerStreak: 1,
    })
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(executionStarted("ses_1"))
    await router.handle({ type: "session.tool.called", data: { sessionID: "ses_1", input: { op: "block" } } })
    await router.handle(executionSucceeded("ses_1"))
    expect((await deps.repo.load("ses_1"))?.blockerStreak).toBe(1)
  })

  test("keeps turn state per session", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_a", createGoal({ goalId: "ga", objective: "o", now: 0 }))
    await deps.repo.save("ses_b", createGoal({ goalId: "gb", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })

    // A 完成一个用户轮 → 注入续跑，A 置 pending
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_a", agent: "build" } })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_b", agent: "build" } })
    await router.handle(executionStarted("ses_a"))
    await router.handle(executionSucceeded("ses_a"))
    // B 走一个用户轮（无自己的 pending）→ 不得消费 A 的 pending
    await router.handle(executionStarted("ses_b"))
    await router.handle(executionSucceeded("ses_b"))
    expect((await deps.repo.load("ses_b"))?.emptyStreak).toBe(0)

    // A 的 pending 仍在：A 的下一轮是 automatic 空转
    await router.handle(executionStarted("ses_a"))
    await router.handle(executionSucceeded("ses_a"))
    expect((await deps.repo.load("ses_a"))?.emptyStreak).toBe(1)
    expect(prompts).toEqual(["ses_a", "ses_b", "ses_a"])
  })

  test("a repeated execution end settles the turn only once", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })

    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1")) // 用户轮 → 注入一次
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1")) // automatic 空转 → 注入一次
    await router.handle(executionSucceeded("ses_1")) // 重复结束事件：不再结算

    expect((await deps.repo.load("ses_1"))?.emptyStreak).toBe(1)
    expect(injected).toBe(2)
  })

  test("user-triggered turns never grow the empty streak", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    for (let turn = 0; turn < 3; turn++) {
      await router.handle(executionStarted("ses_1"))
      await router.handle(executionSucceeded("ses_1"))
    }
    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("active")
    expect(goal?.emptyStreak).toBe(0)
  })

  test("an execution end without a preceding start neither settles nor continues", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    await router.handle(executionSucceeded("ses_1"))
    expect(injected).toBe(0)
    expect((await deps.repo.load("ses_1"))?.emptyStreak).toBe(0)
  })

  test("an interruption discards the pending continuation", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => true })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1")) // 注入续跑 → pending 置位
    await router.handle({ type: "session.execution.interrupted", data: { sessionID: "ses_1", reason: "user" } })
    // 用户恢复目标后，下一轮不应被残留的 pending 误标为 automatic
    const paused = (await deps.repo.load("ses_1"))!
    await deps.repo.save("ses_1", { ...paused, status: "active" })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect((await deps.repo.load("ses_1"))?.emptyStreak).toBe(0)
  })

  test("session.deleted clears per-session state", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1")) // pending 置位 + 注入
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_1" } })
    expect(await deps.repo.load("ses_1")).toBeUndefined()

    const before = injected
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(await deps.repo.load("ses_1")).toBeUndefined()
    expect(injected).toBe(before)
  })

  test("an unknown agent skips continuation", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(
      deps,
      createContinuation(deps, {
        deliver: async (input) => {
          prompts.push(input.sessionID)
        },
      }),
    )
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })

  test("a plan agent learned from step.started does not continue", async () => {
    const deps = { ...makeDeps(), isRestricted: (agentId: string) => agentId === "plan" }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(
      deps,
      createContinuation(deps, {
        deliver: async (input) => {
          prompts.push(input.sessionID)
        },
      }),
    )
    await router.handle(executionStarted("ses_1"))
    await router.handle({ type: "session.step.started", data: { sessionID: "ses_1", agent: "plan", started: 0 } })
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })

  test("a plan agent learned from session.created does not continue", async () => {
    const deps = { ...makeDeps(), isRestricted: (agentId: string) => agentId === "plan" }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(
      deps,
      createContinuation(deps, {
        deliver: async (input) => {
          prompts.push(input.sessionID)
        },
      }),
    )
    await router.handle({ type: "session.created", data: { sessionID: "ses_1", agent: "plan" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })

  test("a failed execution settles the turn but does not continue", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionFailed("ses_1"))
    expect(injected).toBe(0)
    expect((await deps.repo.load("ses_1"))?.emptyStreak).toBe(0)
  })

  test("the deprecated session.status event neither opens nor settles a turn", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } })
    await router.handle({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } })
    expect(injected).toBe(0)
    expect((await deps.repo.load("ses_1"))?.emptyStreak).toBe(0)
  })

  test("events from another location are ignored", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = makeRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    const other = { directory: "other" }
    await router.handle({ type: "session.agent.selected", location: other, data: { sessionID: "ses_1", agent: "build" } })
    await router.handle({ type: "session.step.started", location: other, data: { sessionID: "ses_1", agent: "build", started: 0 } })
    await router.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    await router.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(injected).toBe(0)
  })

  test("an unlocated execution end is admitted via the session's directory", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = createEventRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    // 不带 location 的事件回落到查询会话目录（本 location）→ 放行；但 agent 未知 → 不续跑
    await router.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    await router.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(injected).toBe(0)
    // agent 已知后再次成轮 → 正常结算并续跑
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    await router.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(injected).toBe(1)
  })

  test("unlocated events for another location's session are ignored", async () => {
    const deps = { ...makeDeps(), sessionDirectory: async () => "other-location" }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = createEventRouter(deps, {
      onIdle: async () => {
        injected += 1
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    await router.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
    expect(injected).toBe(0)
  })

  test("a running background shell defers continuation", async () => {
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

  test("diagnostics reports the pending background count", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = makeRouter(deps, { onIdle: async () => false })
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_1" }))
    const state = router.diagnostics().sessions.find((item) => item.sessionID === "ses_1")
    expect(state?.pendingBackground).toBe(1)
  })

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
    // 移出一个（metadata 主路径命中）→ 仍不续跑
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

  test("the ordering guard expires after its TTL", async () => {
    let now = 1000
    const deps = { ...makeDeps(), now: () => now }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = makeRouter(deps, {
      onIdle: async (sessionID) => {
        prompts.push(sessionID)
        return true
      },
    })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    // 完成通知先到（key 记入 recentlyCompleted）
    await router.handle(inboxEnqueued("ses_1", { source: "shell", shellID: "sh_x" }))
    // 时间推进超过 TTL（30s）→ 护栏失效，起信号重新入 pending
    now = 1000 + 31_000
    await router.handle(toolSuccess("ses_1", { status: "running", shellID: "sh_x" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })

  test("session.deleted clears the session's own pending", async () => {
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
    expect(prompts).toEqual([])
    // 会话被删 → 其自身 pending 被清（真实会话 id 不复用，这里仅重建记录观察）
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_1" } })
    await deps.repo.save("ses_1", createGoal({ goalId: "g2", objective: "o", now: 0 }))
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })

  test("a late start signal after a child session is deleted does not re-enter pending", async () => {
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
    // 子会话被删（记入乱序护栏）
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_child" } })
    // 迟到的起信号：护栏应拦住，不再入 pending
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual(["ses_1"])
  })

  test("a background task can restart with the same key after a normal completion", async () => {
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
    // 第一次：起 → 止（正常顺序）
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
    await router.handle(inboxEnqueued("ses_1", { source: "subagent", childID: "ses_child" }))
    // 第二次：同一 key 再次起（continue-existing subagent）→ 应重新入 pending，不得被护栏误挡
    await router.handle(executionStarted("ses_1"))
    await router.handle(toolSuccess("ses_1", { status: "running", sessionID: "ses_child" }))
    await router.handle(executionSucceeded("ses_1"))
    expect(prompts).toEqual([])
  })
})
