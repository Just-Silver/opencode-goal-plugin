import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { messagesFor } from "../i18n"
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
    messages: messagesFor("en"),
    now: () => 5000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: "test-location",
    sessionDirectory: async () => "test-location",
    ...overrides,
  }
}

describe("createContinuation", () => {
  test("injects the continuation prompt for an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "finish X", now: 0 }))
    const sent: Array<{ text: string; description: string }> = []
    const continuation = createContinuation(deps, {
      deliver: async (input) => {
        sent.push({ text: input.text, description: input.description })
      },
    })
    expect(await continuation.onIdle("ses_1", "build")).toBe(true)
    // 触发只有一行：目标本体由 context 钩子注入 system，不进消息历史。
    expect(sent[0]?.text.split("\n")).toHaveLength(1)
    expect(sent[0]?.text).not.toContain("finish X")
    // TUI 只渲染 description；它得能说明这一轮是什么。
    expect(sent[0]?.description).toContain("finish X")
    expect(sent[0]?.description.length).toBeLessThan(120)
    expect((await deps.repo.load("ses_1"))?.lastContinuationAt).toBe(5000)
  })

  test("does nothing without an active goal", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), status: "paused" })
    const sent: string[] = []
    const continuation = createContinuation(deps, { deliver: async () => void sent.push("x") })
    expect(await continuation.onIdle("ses_1", "build")).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test("does nothing for a restricted agent", async () => {
    const deps = makeDeps({ isRestricted: (agent) => agent === "plan" })
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const sent: string[] = []
    const continuation = createContinuation(deps, { deliver: async () => void sent.push("x") })
    expect(await continuation.onIdle("ses_1", "plan")).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
