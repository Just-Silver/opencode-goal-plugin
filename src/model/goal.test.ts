import { describe, expect, test } from "bun:test"
import { GoalError, complete, createGoal, pause, recordContinuation, resume } from "./goal"

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
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
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

  test("resume clears the blocker audit and zeroes emptyStreak", () => {
    const blocked = {
      ...goal,
      status: "blocked" as const,
      blockerKey: "build-failed",
      blockerText: "build failed",
      blockerStreak: 3,
      emptyStreak: 2,
    }
    const resumed = resume(blocked, 5000)
    expect(resumed.status).toBe("active")
    expect(resumed.blockerKey).toBeUndefined()
    expect(resumed.blockerText).toBeUndefined()
    expect(resumed.blockerStreak).toBe(0)
    expect(resumed.emptyStreak).toBe(0)
  })

  test("resumes from budget-limited", () => {
    const limited = { ...goal, status: "budget-limited" as const }
    expect(resume(limited, 6000).status).toBe("active")
  })

  test("resumes from usage-limited and clears lastError", () => {
    const limited = {
      ...goal,
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit", at: 1234 },
    }
    const resumed = resume(limited, 6000)
    expect(resumed.status).toBe("active")
    expect(resumed.lastError).toBeUndefined()
  })

  test("pause leaves a complete goal untouched", () => {
    const done = complete(goal, 2000)
    const paused = pause(done, 3000)
    expect(paused.status).toBe("complete")
    expect(paused.updatedAt).toBe(2000)
  })
})

describe("recordContinuation", () => {
  test("counts from zero when the field is absent (legacy record)", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
    const next = recordContinuation(goal, 111)
    expect(next.continuations).toBe(1)
    expect(next.lastContinuationAt).toBe(111)
    expect(next.updatedAt).toBe(111)
  })

  test("increments an existing count without mutating the input", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), continuations: 3 }
    const next = recordContinuation(goal, 5)
    expect(next.continuations).toBe(4)
    expect(goal.continuations).toBe(3)
  })
})
