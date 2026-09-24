import { describe, expect, test } from "bun:test"
import { accrue, tokenCost } from "./usage"
import { createGoal } from "./goal"

describe("tokenCost", () => {
  test("counts output + reasoning + cacheWrite, ignores input and cacheRead", () => {
    expect(tokenCost({ input: 1000, output: 10, reasoning: 5, cacheWrite: 2 })).toBe(17)
  })
})

describe("accrue", () => {
  const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })

  test("adds the delta and elapsed seconds on an active goal", () => {
    const next = accrue(goal, { input: 9, output: 10, reasoning: 5, cacheWrite: 2 }, 30, 100)
    expect(next.tokensUsed).toBe(17)
    expect(next.timeUsedSeconds).toBe(30)
    expect(next.updatedAt).toBe(100)
  })

  test("ignores non-active goals", () => {
    const paused = { ...goal, status: "paused" as const }
    expect(accrue(paused, { input: 0, output: 10, reasoning: 0, cacheWrite: 0 }, 5, 100)).toEqual(paused)
  })
})
