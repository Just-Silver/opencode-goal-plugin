import { describe, expect, test } from "bun:test"
import { buildToolResult } from "./tool-result"
import { createGoal } from "./goal"

describe("buildToolResult", () => {
  test("reports no budget as null remaining", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    const result = buildToolResult(goal)
    expect(result.remainingTokens).toBeNull()
    expect(result.completionBudgetReport).toContain("no token budget")
    expect(result.goal.status).toBe("active")
  })

  test("reports remaining tokens against the budget", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 500 }), tokensUsed: 120 }
    const result = buildToolResult(goal)
    expect(result.remainingTokens).toBe(380)
    expect(result.completionBudgetReport).toContain("380")
  })

  test("exposes the usage breakdown and reports it in the budget line", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      tokensUsed: 1067,
      usage: { input: 1000, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 },
    }
    const result = buildToolResult(goal)
    expect(result.goal.usage).toEqual({ input: 1000, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 })
    expect(result.completionBudgetReport).toContain("cacheRead 50")
    expect(result.completionBudgetReport).toContain("new work 1017")
  })

  test("includes the full objective and the blocker streak", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "x".repeat(5000), now: 0 }), blockerStreak: 2 }
    const result = buildToolResult(goal)
    expect(result.goal.objective).toHaveLength(5000)
    expect(result.blockerStreak).toBe(2)
  })
})
