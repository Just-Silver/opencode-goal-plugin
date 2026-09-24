import { describe, expect, test } from "bun:test"
import { applyBudget } from "./limits"
import { createGoal } from "./goal"

describe("applyBudget", () => {
  test("marks an active goal budget-limited when tokensUsed reaches the budget", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }), tokensUsed: 100 }
    expect(applyBudget(goal, 10).status).toBe("budget-limited")
  })

  test("leaves a goal below budget untouched", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }), tokensUsed: 99 }
    expect(applyBudget(goal, 10)).toEqual(goal)
  })

  test("does nothing without a budget", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), tokensUsed: 9999 }
    expect(applyBudget(goal, 10)).toEqual(goal)
  })

  test("upgrades a blocked goal to budget-limited when over budget (budget outranks blocked)", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }),
      status: "blocked" as const,
      tokensUsed: 100,
    }
    const limited = applyBudget(goal, 10)
    expect(limited.status).toBe("budget-limited")
    expect(limited.updatedAt).toBe(10)
  })

  test("leaves a blocked goal under budget untouched", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }),
      status: "blocked" as const,
      tokensUsed: 99,
    }
    expect(applyBudget(goal, 10)).toEqual(goal)
  })
})
