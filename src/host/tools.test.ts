import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { messagesFor } from "../i18n"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createGoalTool } from "./tools"
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
  let id = 0
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS },
    messages: messagesFor("en"),
    now: () => 1000,
    newGoalId: () => `g${++id}`,
    isRestricted: () => false,
    locationDirectory: "test-location",
    sessionDirectory: async () => "test-location",
    ...overrides,
  }
}

const ctx = { sessionID: "ses_1", agent: "build" }
const parse = (result: { content: string }) => JSON.parse(result.content)

/** 直接落一条目标（创建归用户命令，工具不再有 create）。 */
function seed(deps: GoalDeps, goal = createGoal({ goalId: "g1", objective: "x", now: 0 })) {
  return deps.repo.save("ses_1", goal)
}

describe("createGoalTool", () => {
  test("only get / complete / rewrite / block are model-callable", async () => {
    const tool = createGoalTool(makeDeps())
    for (const op of ["create", "resume", "drop", "budget"])
      await expect(tool.execute({ op }, ctx)).rejects.toThrow(/op must be one of/)
  })

  test("get returns null when no goal exists", async () => {
    const tool = createGoalTool(makeDeps())
    expect(parse(await tool.execute({ op: "get" }, ctx)).goal).toBeNull()
  })

  test("get reports an existing goal", async () => {
    const deps = makeDeps()
    await seed(deps, createGoal({ goalId: "g1", objective: "finish X", now: 0 }))
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "get" }, ctx))
    expect(result.goal.objective).toBe("finish X")
  })

  test("overlays the in-flight turn usage on tool results", async () => {
    // 记账改成轮末落盘后，KV 在轮中还是旧值；工具返回必须叠加内存里的本轮 pending。
    const deps = makeDeps({
      pendingUsage: () => ({
        tokens: { input: 100, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 },
        elapsedSeconds: 3,
      }),
    })
    await seed(deps)
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "get" }, ctx))
    expect(result.goal.tokensUsed).toBe(167)
    expect(result.goal.timeUsedSeconds).toBe(3)
    expect(result.completionBudgetReport).toContain("tokens used 167")
  })

  test("complete marks an active goal complete and then refuses again", async () => {
    const deps = makeDeps()
    await seed(deps)
    const tool = createGoalTool(deps)
    const done = parse(await tool.execute({ op: "complete" }, ctx))
    expect(done.goal.status).toBe("complete")
    await expect(tool.execute({ op: "complete" }, ctx)).rejects.toThrow(/cannot complete/)
  })

  test("complete requires an existing goal", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({ op: "complete" }, ctx)).rejects.toThrow(/no goal/)
  })

  test("block requires an existing goal", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({ op: "block", blocker_key: "k" }, ctx)).rejects.toThrow(/no goal/)
  })

  test("block counts to the threshold and returns the wrap-up instruction", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 2 } })
    await seed(deps)
    const tool = createGoalTool(deps)
    await tool.execute({ op: "block", blocker_key: "no-key", blocker: "missing key" }, ctx)
    const second = parse(await tool.execute({ op: "block", blocker_key: "no-key", blocker: "missing key" }, ctx))
    expect(second.goal.status).toBe("blocked")
    expect(second.instruction).toContain("no-key")
  })

  test("block reaching the budget limit returns the budget instruction", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 3, tokenBudget: 5 } })
    await seed(deps, { ...createGoal({ goalId: "g1", objective: "x", now: 0, tokenBudget: 5 }), tokensUsed: 5 })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "block", blocker_key: "k", blocker: "stuck" }, ctx))
    expect(result.goal.status).toBe("budget-limited")
    expect(result.instruction).toContain("token budget")
  })

  test("refuses a blocker report on a non-active goal instead of silently doing nothing", async () => {
    for (const status of ["paused", "blocked", "budget-limited", "usage-limited", "complete"] as const) {
      const deps = makeDeps()
      await seed(deps, { ...createGoal({ goalId: "g1", objective: "x", now: 0 }), status })
      const tool = createGoalTool(deps)
      await expect(tool.execute({ op: "block", blocker_key: "k" }, ctx)).rejects.toThrow(/cannot report a blocker/)
      expect((await deps.repo.load("ses_1"))?.status).toBe(status)
    }
  })

  test("invalid input is rejected before touching storage", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({}, ctx)).rejects.toThrow(/op must be one of/)
  })

  test("tool description and parameter descriptions follow the language", () => {
    const en = createGoalTool(makeDeps())
    const zh = createGoalTool({ ...makeDeps(), messages: messagesFor("zh-CN") })
    expect(en.description).toContain("persistent goal")
    expect(zh.description).toContain("持久目标")
    expect(zh.input.properties.op.description).toContain("操作")
    expect(zh.input.properties.objective.description).toContain("目标正文")
  })
})

describe("rewrite op", () => {
  test("rewrites only the objective and preserves status, budget and accounting", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "old", now: 0, tokenBudget: 500 }),
      status: "paused" as const,
      tokensUsed: 42,
      usage: { input: 10, output: 20, reasoning: 0, cacheRead: 12, cacheWrite: 0 },
      timeUsedSeconds: 7,
      continuations: 3,
    })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "rewrite", objective: "  new objective  " }, ctx))
    expect(result.goal.objective).toBe("new objective")
    expect(result.goal.status).toBe("paused")
    expect(result.goal.tokenBudget).toBe(500)
    expect(result.goal.tokensUsed).toBe(42)
    const stored = await deps.repo.load("ses_1")
    expect(stored?.objective).toBe("new objective")
    expect(stored?.status).toBe("paused")
    expect(stored?.tokenBudget).toBe(500)
    expect(stored?.tokensUsed).toBe(42)
    expect(stored?.usage).toEqual({ input: 10, output: 20, reasoning: 0, cacheRead: 12, cacheWrite: 0 })
    expect(stored?.timeUsedSeconds).toBe(7)
    expect(stored?.continuations).toBe(3)
    expect(stored?.createdAt).toBe(0)
    expect(stored?.updatedAt).toBe(1000)
  })

  test("requires an existing goal", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({ op: "rewrite", objective: "x" }, ctx)).rejects.toThrow(/no goal/)
  })

  test("rejects an empty objective", async () => {
    const deps = makeDeps()
    await seed(deps)
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "rewrite", objective: "   " }, ctx)).rejects.toThrow(/objective/)
  })

  test("refuses a completed goal and leaves it untouched", async () => {
    const deps = makeDeps()
    await seed(deps, { ...createGoal({ goalId: "g1", objective: "old", now: 0 }), status: "complete" as const })
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "rewrite", objective: "new" }, ctx)).rejects.toThrow(/complete/)
    expect((await deps.repo.load("ses_1"))?.objective).toBe("old")
  })

  test("on a non-active goal it returns an instruction that the goal will not continue", async () => {
    const deps = makeDeps()
    await seed(deps, { ...createGoal({ goalId: "g1", objective: "old", now: 0 }), status: "paused" as const })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "rewrite", objective: "new" }, ctx))
    expect(result.goal.objective).toBe("new")
    expect(result.goal.status).toBe("paused")
    expect(result.instruction).toContain("/goal-resume")
  })

  test("on an active goal it returns no instruction", async () => {
    const deps = makeDeps()
    await seed(deps)
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "rewrite", objective: "new" }, ctx))
    expect(result.instruction).toBeUndefined()
  })

  test("is refused for a restricted agent and writes nothing", async () => {
    const deps = makeDeps({ isRestricted: () => true })
    await seed(deps, createGoal({ goalId: "g1", objective: "old", now: 0 }))
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "rewrite", objective: "new" }, ctx)).rejects.toThrow(/cannot rewrite/)
    expect((await deps.repo.load("ses_1"))?.objective).toBe("old")
  })
})
