import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createCompactionHook, createContextHook } from "./hooks"
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
    options: { ...DEFAULT_OPTIONS },
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
  }
}

describe("createContextHook", () => {
  test("appends a light reminder only while the goal is active", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const hook = createContextHook(deps)
    const active = { sessionID: "ses_1", agent: "build", system: [] as { type: "text"; text: string }[] }
    await hook(active)
    expect(active.system).toHaveLength(1)
    expect(active.system[0]?.text).toContain('op "get"')

    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), status: "paused" })
    const paused = { sessionID: "ses_1", agent: "build", system: [] as { type: "text"; text: string }[] }
    await hook(paused)
    expect(paused.system).toHaveLength(0)
  })
})

describe("createCompactionHook", () => {
  test("appends the goal snapshot for any existing goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "keep me", now: 0 }))
    const hook = createCompactionHook(deps)
    const input = { sessionID: "ses_1", agent: "build", system: [] as { type: "text"; text: string }[] }
    await hook(input)
    expect(input.system[0]?.text).toContain("keep me")
    expect(input.system[0]?.text).toContain("<goal_snapshot>")
  })

  test("does nothing when no goal exists", async () => {
    const hook = createCompactionHook(makeDeps())
    const input = { sessionID: "ses_none", agent: "build", system: [] as { type: "text"; text: string }[] }
    await hook(input)
    expect(input.system).toHaveLength(0)
  })
})
