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
})
