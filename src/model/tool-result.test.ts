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

  test("includes the full objective and the blocker streak", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "x".repeat(5000), now: 0 }), blockerStreak: 2 }
    const result = buildToolResult(goal)
    expect(result.goal.objective).toHaveLength(5000)
    expect(result.blockerStreak).toBe(2)
  })
})
