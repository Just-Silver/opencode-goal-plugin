import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { createGoal, pause } from "../model/goal"
import { createRepository, type Repository, type StorageLike } from "../store/repository"
import { createCommandHandler, parseGoalCommand } from "./commands"
import type { GoalDeps } from "./deps"

describe("parseGoalCommand", () => {
  test("recognizes the deterministic subcommands case-insensitively", () => {
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" })
    expect(parseGoalCommand("  RESUME ")).toEqual({ kind: "resume" })
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" })
  })

  test("blank or status/show reports the goal", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "status" })
    expect(parseGoalCommand("status")).toEqual({ kind: "status" })
    expect(parseGoalCommand("show")).toEqual({ kind: "status" })
  })

  test("everything else is treated as an objective (including an optional start/begin verb)", () => {
    expect(parseGoalCommand("ship the release")).toEqual({ kind: "objective", objective: "ship the release" })
    expect(parseGoalCommand("start ship the release")).toEqual({ kind: "objective", objective: "ship the release" })
    expect(parseGoalCommand("begin")).toEqual({ kind: "objective", objective: "begin" })
  })

  test("a bare start falls through to an objective", () => {
    expect(parseGoalCommand("start")).toEqual({ kind: "objective", objective: "start" })
  })

  test("a reserved name ignores any trailing arguments", () => {
    expect(parseGoalCommand("resume now")).toEqual({ kind: "resume" })
    expect(parseGoalCommand("status please")).toEqual({ kind: "status" })
  })
})

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

function runner(deps: GoalDeps) {
  const prompts: string[] = []
  const descriptions: string[] = []
  const notices: string[] = []
  const handler = createCommandHandler(deps, {
    deliver: async (input) => {
      prompts.push(input.text)
      descriptions.push(input.description)
    },
    notify: async (_sessionID, text) => {
      notices.push(text)
    },
  })
  return { handler, prompts, descriptions, notices }
}

function makeHandler() {
  const deps: GoalDeps = {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS },
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: "test-location",
    sessionDirectory: async () => "test-location",
  }
  return { deps, ...runner(deps) }
}

describe("createCommandHandler", () => {
  test("objective text is forwarded to the model", async () => {
    const { handler, prompts, descriptions } = makeHandler()
    await handler({ sessionID: "ses_1", prompt: { text: "ship it" } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("ship it")
    // TUI 只显示 description 一行；整段 prompt 不该进转录。
    expect(descriptions[0]).toBe("Goal request · ship it")
  })

  test("pause and resume are handled deterministically", async () => {
    const { deps, handler, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handler({ sessionID: "ses_1", prompt: { text: "pause" } })
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
    await handler({ sessionID: "ses_1", prompt: { text: "resume" } })
    expect((await deps.repo.load("ses_1"))?.status).toBe("active")
    expect(notices.some((line) => line.includes("paused"))).toBe(true)
  })

  test("clear removes the record", async () => {
    const { deps, handler } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handler({ sessionID: "ses_1", prompt: { text: "clear" } })
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("status with no goal reports that none is set", async () => {
    const { handler, notices } = makeHandler()
    await handler({ sessionID: "ses_1", prompt: { text: "" } })
    expect(notices[0]).toContain("No goal")
  })

  test("resume on a non-resumable goal reports it and leaves the status unchanged", async () => {
    const { deps, handler, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handler({ sessionID: "ses_1", prompt: { text: "resume" } })
    expect(notices.some((line) => line.includes("nothing to resume"))).toBe(true)
    expect((await deps.repo.load("ses_1"))?.status).toBe("active")
  })

  test("pause on a non-active goal reports nothing to pause", async () => {
    const { deps, handler, notices } = makeHandler()
    await deps.repo.save("ses_1", pause(createGoal({ goalId: "g1", objective: "o", now: 0 }), 1))
    await handler({ sessionID: "ses_1", prompt: { text: "pause" } })
    expect(notices.some((line) => line.includes("nothing to pause"))).toBe(true)
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
  })

  test("pause and clear without a goal do not throw and report no goal", async () => {
    const { handler, notices } = makeHandler()
    await handler({ sessionID: "ses_1", prompt: { text: "pause" } })
    await handler({ sessionID: "ses_1", prompt: { text: "clear" } })
    expect(notices).toHaveLength(2)
    expect(notices.every((line) => line.includes("No goal"))).toBe(true)
  })

  test("a storage error while resuming propagates instead of being reported as not-resumable", async () => {
    const stored = pause(createGoal({ goalId: "g1", objective: "o", now: 0 }), 1)
    const repo: Repository = {
      load: async () => stored,
      save: async () => {
        throw new Error("storage down")
      },
      remove: async () => {},
      listAll: async () => [],
    }
    const { handler, notices } = runner({
      repo,
      options: { ...DEFAULT_OPTIONS },
      now: () => 1000,
      newGoalId: () => "g1",
      isRestricted: () => false,
      locationDirectory: "test-location",
      sessionDirectory: async () => "test-location",
    })
    await expect(handler({ sessionID: "ses_1", prompt: { text: "resume" } })).rejects.toThrow("storage down")
    expect(notices).toHaveLength(0)
  })
})
