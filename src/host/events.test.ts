import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createEventRouter } from "./events"
import { createTurnTracker } from "./turn"
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

function makeDeps(): GoalDeps {
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS, blockedThreshold: 3, emptyThreshold: 3 },
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
  }
}

const busy = (sessionID: string) => ({ type: "session.status", data: { sessionID, status: { type: "busy" } } })
const idle = (sessionID: string) => ({ type: "session.status", data: { sessionID, status: { type: "idle" } } })

describe("createEventRouter", () => {
  test("accrues tokens and continues once on idle", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const prompts: string[] = []
    const router = createEventRouter(deps, createTurnTracker(), {
      onIdle: async (_sessionID, agentId) => {
        prompts.push(agentId)
        return true
      },
    })

    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(busy("ses_1"))
    await router.handle({ type: "session.text.ended", data: { sessionID: "ses_1", text: "working" } })
    await router.handle({
      type: "session.step.ended",
      data: { sessionID: "ses_1", tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 2 } } },
    })
    await router.handle(idle("ses_1"))

    expect((await deps.repo.load("ses_1"))?.tokensUsed).toBe(17)
    expect(prompts).toEqual(["build"])
  })

  test("three consecutive empty automatic turns block the goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    let injected = 0
    const router = createEventRouter(deps, createTurnTracker(), {
      onIdle: async () => {
        injected += 1
        return true
      },
    })

    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(idle("ses_1")) // 首次空闲：注入续跑（automatic 标记置位）
    for (let turn = 0; turn < 3; turn++) {
      await router.handle(busy("ses_1"))
      await router.handle(idle("ses_1"))
    }

    const goal = await deps.repo.load("ses_1")
    expect(goal?.status).toBe("blocked")
    expect(goal?.emptyStreak).toBe(3)
    expect(injected).toBeLessThanOrEqual(3)
  })

  test("session.deleted removes the record", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = createEventRouter(deps, createTurnTracker(), { onIdle: async () => false })
    await router.handle({ type: "session.deleted", data: { sessionID: "ses_1" } })
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("an interruption pauses an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const router = createEventRouter(deps, createTurnTracker(), { onIdle: async () => false })
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
    const router = createEventRouter(deps, createTurnTracker(), { onIdle: async () => false })
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    await router.handle(busy("ses_1"))
    await router.handle({ type: "session.text.ended", data: { sessionID: "ses_1", text: "moving on" } })
    await router.handle(idle("ses_1"))
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
    const router = createEventRouter(deps, createTurnTracker(), { onIdle: async () => false })
    await router.handle(busy("ses_1"))
    await router.handle({ type: "session.tool.called", data: { sessionID: "ses_1", input: { op: "block" } } })
    await router.handle(idle("ses_1"))
    expect((await deps.repo.load("ses_1"))?.blockerStreak).toBe(1)
  })
})
