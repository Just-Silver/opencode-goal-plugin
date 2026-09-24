import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createContinuation } from "./continuation"
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

function makeDeps(overrides: Partial<GoalDeps> = {}): GoalDeps {
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS },
    now: () => 5000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: "test-location",
    ...overrides,
  }
}

describe("createContinuation", () => {
  test("injects the continuation prompt for an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "finish X", now: 0 }))
    const sent: string[] = []
    const continuation = createContinuation(deps, {
      prompt: async (_sessionID, text) => {
        sent.push(text)
      },
    })
    expect(await continuation.onIdle("ses_1", "build")).toBe(true)
    expect(sent[0]).toContain("finish X")
    expect((await deps.repo.load("ses_1"))?.lastContinuationAt).toBe(5000)
  })

  test("does nothing without an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), status: "paused" })
    const sent: string[] = []
    const continuation = createContinuation(deps, { prompt: async () => void sent.push("x") })
    expect(await continuation.onIdle("ses_1", "build")).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test("does nothing for a restricted agent", async () => {
    const deps = makeDeps({ isRestricted: (agent) => agent === "plan" })
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const sent: string[] = []
    const continuation = createContinuation(deps, { prompt: async () => void sent.push("x") })
    expect(await continuation.onIdle("ses_1", "plan")).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
