import { describe, expect, test } from "bun:test"
import { GoalError, complete, createGoal, drop, pause, resume } from "./goal"

const base = { goalId: "g1", objective: "finish the thing", now: 1000 }

describe("createGoal", () => {
  test("creates an active goal with zero counters", () => {
    const goal = createGoal(base)
    expect(goal).toMatchObject({
      version: 1,
      goalId: "g1",
      objective: "finish the thing",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      blockerStreak: 0,
      emptyStreak: 0,
      createdAt: 1000,
      updatedAt: 1000,
    })
    expect(goal.tokenBudget).toBeUndefined()
  })

  test("carries a token budget", () => {
    expect(createGoal({ ...base, tokenBudget: 500 }).tokenBudget).toBe(500)
  })

  test("rejects a budget above the configured maximum", () => {
    expect(() => createGoal({ ...base, tokenBudget: 900, maxTokenBudget: 500 })).toThrow(GoalError)
    expect(() => createGoal({ ...base, tokenBudget: 900, maxTokenBudget: 500 })).toThrow(/budget/)
  })
})

describe("transitions", () => {
  const goal = createGoal(base)

  test("pause then resume keeps counters", () => {
    const paused = pause(goal, 2000)
    expect(paused.status).toBe("paused")
    expect(paused.updatedAt).toBe(2000)
    expect(resume(paused, 3000).status).toBe("active")
  })

  test("complete only from active", () => {
    expect(complete(goal, 3000).status).toBe("complete")
    expect(() => complete(pause(goal, 2000), 3000)).toThrow(/not-completable/)
  })

  test("resume only from a non-active open status", () => {
    expect(() => resume(goal, 2000)).toThrow(/not-resumable/)
    expect(() => resume(complete(goal, 2000), 3000)).toThrow(/not-resumable/)
  })

  test("drop clears the blocker audit and stops the goal", () => {
    const blocked = { ...goal, status: "blocked" as const, blockerStreak: 2 }
    const dropped = drop(blocked, 4000)
    expect(dropped.status).toBe("complete")
    expect(dropped.blockerStreak).toBe(0)
  })
})
