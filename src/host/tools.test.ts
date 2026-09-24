import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
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
    now: () => 1000,
    newGoalId: () => `g${++id}`,
    isRestricted: () => false,
    ...overrides,
  }
}

const ctx = { sessionID: "ses_1", agent: "build" }
const parse = (result: { content: string }) => JSON.parse(result.content)

describe("createGoalTool", () => {
  test("create stores an active goal", async () => {
    const tool = createGoalTool(makeDeps())
    const result = parse(await tool.execute({ op: "create", objective: "finish X" }, ctx))
    expect(result.goal.status).toBe("active")
    expect(result.goal.objective).toBe("finish X")
  })

  test("create rejects an empty objective", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({ op: "create", objective: "  " }, ctx)).rejects.toThrow(/objective/)
  })

  test("create fails while an open goal exists", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "first" }, ctx)
    await expect(tool.execute({ op: "create", objective: "second" }, ctx)).rejects.toThrow(/already open/)
  })

  test("create is refused for a restricted agent before writing", async () => {
    const deps = makeDeps({ isRestricted: () => true })
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "create", objective: "x" }, ctx)).rejects.toThrow(/cannot create/)
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("get returns null when no goal exists", async () => {
    const tool = createGoalTool(makeDeps())
    expect(parse(await tool.execute({ op: "get" }, ctx)).goal).toBeNull()
  })

  test("resume is refused for a restricted agent", async () => {
    const deps = makeDeps({ isRestricted: () => true })
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "x", now: 0 }),
      status: "paused",
    })
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "resume" }, ctx)).rejects.toThrow(/cannot resume/)
    expect((await deps.repo.load("ses_1"))?.status).toBe("paused")
  })

  test("drop removes the record", async () => {
    const deps = makeDeps()
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x" }, ctx)
    await tool.execute({ op: "drop" }, ctx)
    expect(await deps.repo.load("ses_1")).toBeUndefined()
  })

  test("block counts to the threshold and returns the wrap-up instruction", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 2 } })
    const tool = createGoalTool(deps)
    await tool.execute({ op: "create", objective: "x" }, ctx)
    await tool.execute({ op: "block", blocker_key: "no-key", blocker: "missing key" }, ctx)
    const second = parse(await tool.execute({ op: "block", blocker_key: "no-key", blocker: "missing key" }, ctx))
    expect(second.goal.status).toBe("blocked")
    expect(second.instruction).toContain("no-key")
  })

  test("get reports an existing goal", async () => {
    const tool = createGoalTool(makeDeps())
    await tool.execute({ op: "create", objective: "finish X" }, ctx)
    const result = parse(await tool.execute({ op: "get" }, ctx))
    expect(result.goal.objective).toBe("finish X")
  })

  test("complete marks an active goal complete and then refuses again", async () => {
    const tool = createGoalTool(makeDeps())
    await tool.execute({ op: "create", objective: "x" }, ctx)
    const done = parse(await tool.execute({ op: "complete" }, ctx))
    expect(done.goal.status).toBe("complete")
    await expect(tool.execute({ op: "complete" }, ctx)).rejects.toThrow(/cannot complete/)
  })

  test("resume reactivates a paused goal and re-applies the budget", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "x", now: 0, tokenBudget: 5 }),
      status: "paused",
      tokensUsed: 5,
    })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "resume" }, ctx))
    expect(result.goal.status).toBe("budget-limited")
  })

  test("create defaults the budget to options.tokenBudget", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, tokenBudget: 42 } })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "create", objective: "x" }, ctx))
    expect(result.goal.tokenBudget).toBe(42)
    expect(result.remainingTokens).toBe(42)
  })

  test("create rejects a token_budget above maxGoalTokenBudget", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, maxGoalTokenBudget: 50 } })
    const tool = createGoalTool(deps)
    await expect(tool.execute({ op: "create", objective: "x", token_budget: 100 }, ctx)).rejects.toThrow(/exceeds max/)
  })

  test("complete, resume, drop and block require an existing goal", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({ op: "complete" }, ctx)).rejects.toThrow(/no goal/)
    await expect(tool.execute({ op: "resume" }, ctx)).rejects.toThrow(/no goal/)
    await expect(tool.execute({ op: "drop" }, ctx)).rejects.toThrow(/no goal/)
    await expect(tool.execute({ op: "block", blocker_key: "k" }, ctx)).rejects.toThrow(/no goal/)
  })

  test("block reaching the budget limit returns the budget instruction", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 3, tokenBudget: 5 } })
    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "x", now: 0, tokenBudget: 5 }), tokensUsed: 5 })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "block", blocker_key: "k", blocker: "stuck" }, ctx))
    expect(result.goal.status).toBe("budget-limited")
    expect(result.instruction).toContain("token budget")
  })

  test("block on an over-budget goal keeps it budget-limited (budget outranks blocked)", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 1, tokenBudget: 5 } })
    await deps.repo.save("ses_1", {
      ...createGoal({ goalId: "g1", objective: "x", now: 0, tokenBudget: 5 }),
      status: "budget-limited",
      tokensUsed: 5,
    })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "block", blocker_key: "k", blocker: "stuck" }, ctx))
    expect(result.goal.status).toBe("budget-limited")
    expect(result.instruction).toContain("token budget")
    expect(result.instruction).not.toContain("blocked")
  })

  test("block that both reaches the threshold and exceeds budget yields budget-limited", async () => {
    const deps = makeDeps({ options: { ...DEFAULT_OPTIONS, blockedThreshold: 1, tokenBudget: 5 } })
    await deps.repo.save("ses_1", { ...createGoal({ goalId: "g1", objective: "x", now: 0, tokenBudget: 5 }), tokensUsed: 5 })
    const tool = createGoalTool(deps)
    const result = parse(await tool.execute({ op: "block", blocker_key: "k", blocker: "stuck" }, ctx))
    expect(result.goal.status).toBe("budget-limited")
    expect(result.instruction).toContain("token budget")
  })

  test("invalid input is rejected before touching storage", async () => {
    const tool = createGoalTool(makeDeps())
    await expect(tool.execute({}, ctx)).rejects.toThrow(/op must be one of/)
  })
})
