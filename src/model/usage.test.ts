import { describe, expect, test } from "bun:test"
import { accrue, addUsage, newWorkOf, tokenCost, usageIsComplete, withPending } from "./usage"
import { createGoal } from "./goal"

describe("tokenCost", () => {
  test("counts the real processed total: input + output + reasoning + cacheRead + cacheWrite", () => {
    expect(tokenCost({ input: 1000, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 })).toBe(1067)
  })
})

describe("newWorkOf", () => {
  test("excludes cacheRead (display only, never the budget)", () => {
    expect(newWorkOf({ input: 1000, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 })).toBe(1017)
  })
})

describe("accrue", () => {
  const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })

  test("adds the delta, the breakdown and elapsed seconds", () => {
    const next = accrue(goal, { input: 9, output: 10, reasoning: 5, cacheRead: 7, cacheWrite: 2 }, 30, 100)
    expect(next.tokensUsed).toBe(33)
    expect(next.usage).toEqual({ input: 9, output: 10, reasoning: 5, cacheRead: 7, cacheWrite: 2 })
    expect(next.timeUsedSeconds).toBe(30)
    expect(next.updatedAt).toBe(100)
  })

  test("accrues regardless of status (attribution is decided by the caller at turn end)", () => {
    const paused = { ...goal, status: "paused" as const }
    const next = accrue(paused, { input: 0, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, 5, 100)
    expect(next.tokensUsed).toBe(10)
    expect(next.timeUsedSeconds).toBe(5)
  })

  test("accumulates into an existing breakdown", () => {
    const once = accrue(goal, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, 0, 1)
    const twice = accrue(once, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, 0, 2)
    expect(twice.tokensUsed).toBe(30)
    expect(twice.usage).toEqual({ input: 2, output: 4, reasoning: 6, cacheRead: 8, cacheWrite: 10 })
  })

  test("starts a breakdown from zeros when the record predates it", () => {
    const legacy = { ...goal, usage: undefined }
    const next = accrue(legacy, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, 0, 1)
    expect(next.usage).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
  })
})

describe("withPending", () => {
  const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), tokensUsed: 10, timeUsedSeconds: 2 }

  test("overlays in-flight usage for display", () => {
    const view = withPending(goal, {
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      elapsedSeconds: 3.9,
    })
    expect(view.tokensUsed).toBe(25)
    expect(view.usage).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
    expect(view.timeUsedSeconds).toBe(5)
    expect(view.updatedAt).toBe(goal.updatedAt) // 展示用，不动时间戳
  })

  test("returns the goal untouched when there is nothing pending", () => {
    expect(withPending(goal, undefined)).toEqual(goal)
  })
})

describe("usageIsComplete", () => {
  const goal = {
    ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
    tokensUsed: 15,
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
  }

  test("true only when the breakdown sums to tokensUsed", () => {
    expect(usageIsComplete(goal)).toBe(true)
    expect(usageIsComplete({ ...goal, tokensUsed: 16 })).toBe(false)
    expect(usageIsComplete({ ...goal, usage: undefined })).toBe(false)
  })
})

describe("addUsage", () => {
  test("starts from zeros when there is no base", () => {
    expect(addUsage(undefined, { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toEqual({
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
    })
  })
})