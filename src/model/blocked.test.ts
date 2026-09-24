import { describe, expect, test } from "bun:test"
import { applyBlocker, normalizeBlockerKey, resetBlockerStreak } from "./blocked"
import { createGoal } from "./goal"

const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })

describe("normalizeBlockerKey", () => {
  test("lowercases, folds width, and collapses non-alphanumerics", () => {
    expect(normalizeBlockerKey("  No  API-Key！ ")).toBe("no-api-key")
  })

  test("truncates to 64 chars", () => {
    expect(normalizeBlockerKey("a".repeat(100))).toHaveLength(64)
  })

  test("empty-ish input yields a stable fallback", () => {
    expect(normalizeBlockerKey("！！！")).toBe("unknown")
  })
})

describe("applyBlocker", () => {
  test("first report starts a streak of 1 and does not block", () => {
    const result = applyBlocker(goal, { key: "no-api-key", text: "missing key" }, 3, 10)
    expect(result.blocked).toBe(false)
    expect(result.goal.blockerStreak).toBe(1)
    expect(result.goal.blockerKey).toBe("no-api-key")
  })

  test("same key increments; reaching the threshold blocks", () => {
    let current = applyBlocker(goal, { key: "k", text: "t" }, 3, 10).goal
    current = applyBlocker(current, { key: "k", text: "t" }, 3, 20).goal
    const third = applyBlocker(current, { key: "k", text: "t" }, 3, 30)
    expect(third.blocked).toBe(true)
    expect(third.goal.status).toBe("blocked")
    expect(third.goal.blockerStreak).toBe(3)
  })

  test("a different normalized key restarts the streak", () => {
    let current = applyBlocker(goal, { key: "a", text: "t" }, 3, 10).goal
    current = applyBlocker(current, { key: "b", text: "t" }, 3, 20).goal
    expect(current.blockerStreak).toBe(1)
    expect(current.blockerKey).toBe("b")
  })

  test("normalizes the report key before comparing streaks", () => {
    const first = applyBlocker(goal, { key: " No API-Key！ ", text: "t" }, 3, 10).goal
    const second = applyBlocker(first, { key: "no-api-key", text: "t" }, 3, 20).goal
    expect(second.blockerStreak).toBe(2)
    expect(second.blockerKey).toBe("no-api-key")
  })
})

describe("resetBlockerStreak", () => {
  test("zeroes the streak without dropping the key", () => {
    const reported = applyBlocker(goal, { key: "k", text: "t" }, 3, 10).goal
    const reset = resetBlockerStreak(reported)
    expect(reset.blockerStreak).toBe(0)
    expect(reset.blockerKey).toBe("k")
  })

  test("leaves an already-zero or non-active goal untouched", () => {
    expect(resetBlockerStreak(goal)).toEqual(goal)
    const blocked = { ...goal, status: "blocked" as const, blockerStreak: 3 }
    expect(resetBlockerStreak(blocked)).toEqual(blocked)
  })
})
