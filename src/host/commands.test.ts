import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { messagesFor } from "../i18n"
import { createGoal, pause } from "../model/goal"
import { createRepository, type Repository, type StorageLike } from "../store/repository"
import { createCommandHandlers, parseGoalCommand } from "./commands"
import type { GoalDeps } from "./deps"

describe("parseGoalCommand", () => {
  test("blank reports the goal", () => {
    expect(parseGoalCommand("")).toEqual({ kind: "status" })
    expect(parseGoalCommand("   ")).toEqual({ kind: "status" })
  })

  test("everything else is the objective verbatim — no reserved names", () => {
    expect(parseGoalCommand("ship the release")).toEqual({ kind: "objective", objective: "ship the release" })
    expect(parseGoalCommand("  ship it  ")).toEqual({ kind: "objective", objective: "ship it" })
    // 旧写法不再被后台拦截：它们会原样作为目标文字转发给模型。
    expect(parseGoalCommand("pause")).toEqual({ kind: "objective", objective: "pause" })
    expect(parseGoalCommand("status")).toEqual({ kind: "objective", objective: "status" })
    expect(parseGoalCommand("start the server")).toEqual({ kind: "objective", objective: "start the server" })
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
  const handlers = createCommandHandlers(deps, {
    deliver: async (input) => {
      prompts.push(input.text)
      descriptions.push(input.description)
    },
    notify: async (_sessionID, text) => {
      notices.push(text)
    },
  })
  return { handlers, prompts, descriptions, notices }
}

function makeDeps(): GoalDeps {
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS },
    messages: messagesFor("en"),
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: "test-location",
    sessionDirectory: async () => "test-location",
  }
}

function makeHandler() {
  const deps = makeDeps()
  return { deps, ...runner(deps) }
}

describe("createCommandHandlers", () => {
  test("goal forwards the objective to the model", async () => {
    const { handlers, prompts, descriptions } = makeHandler()
    await handlers.goal({ sessionID: "ses_1", prompt: { text: "ship it" } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("ship it")
    // TUI 只显示 description 一行；整段 prompt 不该进转录。
    expect(descriptions[0]).toBe("Goal request · ship it")
  })

  test("the goal request notice shows the full objective (no clipping)", async () => {
    const { handlers, descriptions } = makeHandler()
    const objective = "从当前空文件夹开始，创建一个完整、可运行的 C# .NET 10 CLI 待办事项项目。这个任务必须经历多个阶段，不能在完成第一版代码后直接结束。"
    await handlers.goal({ sessionID: "ses_1", prompt: { text: objective } })
    expect(descriptions[0]).toBe(`Goal request · ${objective}`)
    expect(descriptions[0]).not.toContain("…")
  })

  test("an empty goal argument reports the status instead of prompting the model", async () => {
    const { deps, handlers, notices, prompts } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handlers.goal({ sessionID: "ses_1", prompt: { text: "" } })
    expect(prompts).toHaveLength(0)
    expect(notices[0]).toContain("Goal (active)")
  })

  test("status with no goal reports that none is set", async () => {
    const { handlers, notices } = makeHandler()
    await handlers.status("ses_1")
    expect(notices[0]).toContain("No goal")
  })

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

  test("pause and resume are handled deterministically", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handlers.pause("ses_1")
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
    await handlers.resume("ses_1")
    expect((await deps.repo.load("ses_1"))?.status).toBe("active")
    expect(notices.some((line) => line.includes("paused"))).toBe(true)
  })

  test("clear removes the record", async () => {
    const { deps, handlers } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handlers.clear("ses_1")
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("resume on a non-resumable goal reports it and leaves the status unchanged", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    await handlers.resume("ses_1")
    expect(notices.some((line) => line.includes("nothing to resume"))).toBe(true)
    expect((await deps.repo.load("ses_1"))?.status).toBe("active")
  })

  test("pause on a non-active goal reports nothing to pause", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", pause(createGoal({ goalId: "g1", objective: "o", now: 0 }), 1))
    await handlers.pause("ses_1")
    expect(notices.some((line) => line.includes("nothing to pause"))).toBe(true)
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
  })

  test("status, pause and clear without a goal do not throw and report no goal", async () => {
    const { handlers, notices } = makeHandler()
    await handlers.status("ses_1")
    await handlers.pause("ses_1")
    await handlers.clear("ses_1")
    expect(notices).toHaveLength(3)
    expect(notices.every((line) => line.includes("No goal"))).toBe(true)
  })

  test("status overlays the in-flight turn usage", async () => {
    const repo = createRepository(memoryStorage())
    await repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const { handlers, notices } = runner({
      ...makeDeps(),
      repo,
      pendingUsage: () => ({
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
        elapsedSeconds: 2,
      }),
    })
    await handlers.status("ses_1")
    expect(notices[0]).toContain("tokens 160")
    expect(notices[0]).toContain("cacheRead 50")
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
    const { handlers, notices } = runner({ ...makeDeps(), repo })
    await expect(handlers.resume("ses_1")).rejects.toThrow("storage down")
    expect(notices).toHaveLength(0)
  })

  test("notices follow the injected language", async () => {
    const deps = { ...makeDeps(), messages: messagesFor("zh-CN") }
    const { handlers, notices } = runner(deps)
    await handlers.status("ses_1")
    expect(notices[0]).toBe("本会话未设置目标。")
  })

  test("a rendered status line leaves no placeholders", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }),
      tokensUsed: 30,
      usage: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      lastError: { type: "provider.quota", message: "limit", at: 1 },
    })
    await handlers.status("ses_1")
    expect(notices[0]).not.toMatch(/\{[a-zA-Z]+\}/)
    expect(notices[0]).toContain("new work")
    expect(notices[0]).toContain("last error: limit")
  })
})