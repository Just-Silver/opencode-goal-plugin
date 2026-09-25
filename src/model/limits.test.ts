import { describe, expect, test } from "bun:test"
import { applyBudget, setBudget } from "./limits"
import { GoalError, createGoal } from "./goal"
import type { Goal } from "./types"

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

  test("upgrades a usage-limited goal to budget-limited when over budget (budget outranks usage limit)", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }),
      status: "usage-limited" as const,
      tokensUsed: 100,
    }
    const limited = applyBudget(goal, 10)
    expect(limited.status).toBe("budget-limited")
    expect(limited.updatedAt).toBe(10)
  })
})

function base(overrides: Partial<Goal> = {}): Goal {
  return { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), ...overrides }
}

describe("setBudget", () => {
  test("sets a numeric budget on an active goal without changing status", () => {
    const goal = setBudget(base({ tokensUsed: 10 }), { budget: 100, now: 7 })
    expect(goal.tokenBudget).toBe(100)
    expect(goal.status).toBe("active")
    expect(goal.updatedAt).toBe(7)
  })

  test("clearing removes the key entirely (not tokenBudget: undefined)", () => {
    const goal = setBudget(base({ tokenBudget: 100, tokensUsed: 10 }), { budget: undefined, now: 7 })
    expect("tokenBudget" in goal).toBe(false)
    expect(goal.status).toBe("active")
  })

  test("lowering below usage marks an active goal budget-limited", () => {
    const goal = setBudget(base({ tokensUsed: 100 }), { budget: 50, now: 7 })
    expect(goal.status).toBe("budget-limited")
  })

  test("raising above usage turns a budget-limited goal back to active and clears the audit", () => {
    const goal = setBudget(
      base({
        status: "budget-limited",
        tokenBudget: 50,
        tokensUsed: 100,
        blockerKey: "k",
        blockerText: "t",
        blockerStreak: 2,
        emptyStreak: 1,
        lastError: { type: "provider.auth", message: "x", at: 1 },
      }),
      { budget: 500, now: 7 },
    )
    expect(goal.status).toBe("active")
    expect(goal.tokenBudget).toBe(500)
    expect(goal.blockerKey).toBeUndefined()
    expect(goal.blockerText).toBeUndefined()
    expect(goal.blockerStreak).toBe(0)
    expect(goal.emptyStreak).toBe(0)
    expect(goal.lastError).toBeUndefined()
  })

  test("clearing the budget also turns budget-limited back to active", () => {
    const goal = setBudget(base({ status: "budget-limited", tokenBudget: 50, tokensUsed: 100 }), {
      budget: undefined,
      now: 7,
    })
    expect(goal.status).toBe("active")
    expect("tokenBudget" in goal).toBe(false)
  })

  test("a still-insufficient budget leaves it budget-limited", () => {
    const goal = setBudget(base({ status: "budget-limited", tokenBudget: 10, tokensUsed: 100 }), {
      budget: 50,
      now: 7,
    })
    expect(goal.status).toBe("budget-limited")
  })

  test("a lower budget upgrades blocked / usage-limited to budget-limited (system fact wins)", () => {
    expect(setBudget(base({ status: "blocked", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("budget-limited")
    expect(setBudget(base({ status: "usage-limited", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe(
      "budget-limited",
    )
  })

  test("paused and complete goals only get the number, never a status change", () => {
    expect(setBudget(base({ status: "paused", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("paused")
    expect(setBudget(base({ status: "complete", tokensUsed: 100 }), { budget: 50, now: 7 }).status).toBe("complete")
  })

  test("clearing the budget never changes a blocked / usage-limited / paused / complete status", () => {
    expect(setBudget(base({ status: "blocked", tokensUsed: 100 }), { budget: undefined, now: 7 }).status).toBe("blocked")
    expect(setBudget(base({ status: "usage-limited", tokensUsed: 100 }), { budget: undefined, now: 7 }).status).toBe(
      "usage-limited",
    )
    expect(setBudget(base({ status: "paused", tokensUsed: 100 }), { budget: undefined, now: 7 }).status).toBe("paused")
    expect(setBudget(base({ status: "complete", tokensUsed: 100 }), { budget: undefined, now: 7 }).status).toBe(
      "complete",
    )
  })

  test("a sufficient budget leaves blocked / usage-limited / paused / complete untouched", () => {
    expect(setBudget(base({ status: "blocked", tokensUsed: 10 }), { budget: 500, now: 7 }).status).toBe("blocked")
    expect(setBudget(base({ status: "usage-limited", tokensUsed: 10 }), { budget: 500, now: 7 }).status).toBe(
      "usage-limited",
    )
    expect(setBudget(base({ status: "paused", tokensUsed: 10 }), { budget: 500, now: 7 }).status).toBe("paused")
    expect(setBudget(base({ status: "complete", tokensUsed: 10 }), { budget: 500, now: 7 }).status).toBe("complete")
  })

  test("rejects a non-positive / non-integer budget", () => {
    for (const budget of [0, -1, 1.5])
      expect(() => setBudget(base(), { budget, now: 7 })).toThrow(GoalError)
  })

  test("rejects a budget above maxTokenBudget, and only when budget is a number", () => {
    expect(() => setBudget(base(), { budget: 101, maxTokenBudget: 100, now: 7 })).toThrow(/exceeds max_goal_token_budget/)
    expect(setBudget(base(), { budget: undefined, maxTokenBudget: 100, now: 7 }).status).toBe("active")
  })
})
