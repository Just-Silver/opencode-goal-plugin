import { describe, expect, test } from "bun:test"
import { applyTurn } from "./empty"
import { createGoal } from "./goal"

const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })

describe("applyTurn", () => {
  test("an automatic turn with activity resets the streak", () => {
    const dirty = { ...goal, emptyStreak: 2 }
    const result = applyTurn(dirty, { automatic: true, hasActivity: true }, 3, 10)
    expect(result.blocked).toBe(false)
    expect(result.goal.emptyStreak).toBe(0)
  })

  test("a user-triggered turn resets the streak", () => {
    const result = applyTurn({ ...goal, emptyStreak: 2 }, { automatic: false, hasActivity: false }, 3, 10)
    expect(result.goal.emptyStreak).toBe(0)
  })

  test("three consecutive empty automatic turns block", () => {
    let current = applyTurn(goal, { automatic: true, hasActivity: false }, 3, 10).goal
    current = applyTurn(current, { automatic: true, hasActivity: false }, 3, 20).goal
    const third = applyTurn(current, { automatic: true, hasActivity: false }, 3, 30)
    expect(third.goal.emptyStreak).toBe(3)
    expect(third.blocked).toBe(true)
    expect(third.goal.status).toBe("blocked")
  })

  test("a non-active goal is left untouched", () => {
    const paused = { ...goal, status: "paused" as const }
    const result = applyTurn(paused, { automatic: true, hasActivity: false }, 3, 10)
    expect(result.blocked).toBe(false)
    expect(result.goal).toEqual(paused)
  })
})
