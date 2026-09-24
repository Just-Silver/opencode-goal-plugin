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
  }
}

const executionStarted = (sessionID: string) => ({ type: "session.execution.started", data: { sessionID } })
const executionSucceeded = (sessionID: string) => ({ type: "session.execution.succeeded", data: { sessionID } })
const executionFailed = (sessionID: string) => ({ type: "session.execution.failed", data: { sessionID } })

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
})
