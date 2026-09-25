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

  test("hides an incomplete breakdown instead of showing mismatched numbers", () => {
    // 旧记录（无 usage）升级后被 accrue：usage 只有增量，与 tokensUsed 不等 → 只给总量。
    const legacy = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), tokensUsed: 100 }
    const result = buildToolResult(legacy)
    expect(result.goal.usage).toBeNull()
    expect(result.completionBudgetReport).not.toContain("cacheRead")

    const partial = {
      ...legacy,
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, // 和 2 ≠ 100
    }
    const result2 = buildToolResult(partial)
    expect(result2.goal.usage).toBeNull()
    expect(result2.completionBudgetReport).not.toContain("cacheRead")
  })

  test("includes the full objective and the blocker streak", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "x".repeat(5000), now: 0 }), blockerStreak: 2 }
    const result = buildToolResult(goal)
    expect(result.goal.objective).toHaveLength(5000)
    expect(result.blockerStreak).toBe(2)
  })

  test("reports lastError as null when absent", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    expect(buildToolResult(goal).goal.lastError).toBeNull()
  })

  test("exposes lastError when present", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit", at: 7 },
    }
    expect(buildToolResult(goal).goal.lastError).toEqual({ type: "provider.quota", message: "weekly usage limit", at: 7 })
  })
})
