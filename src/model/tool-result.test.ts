import { describe, expect, test } from "bun:test"
import { buildToolResult } from "./tool-result"
import { createGoal } from "./goal"

describe("buildToolResult", () => {
  test("reports the objective, status and token totals", () => {
    const goal = createGoal({ goalId: "g1", objective: "finish X", now: 0 })
    const text = buildToolResult(goal)
    expect(text).toContain("Goal: finish X")
    expect(text).toContain("Status: active")
    expect(text).toContain("Tokens: 0 used (no budget)")
  })

  test("reports remaining tokens against the budget", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 500 }), tokensUsed: 120 }
    expect(buildToolResult(goal)).toContain("Tokens: 120 used / 500 budget · 380 remaining")
  })

  test("reports the usage breakdown when it adds up", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      tokensUsed: 1067,
      usage: { input: 1000, output: 10, reasoning: 5, cacheRead: 50, cacheWrite: 2 },
    }
    expect(buildToolResult(goal)).toContain("cache read 50, new work 1017")
  })

  test("hides an incomplete breakdown instead of showing mismatched numbers", () => {
    // 旧记录（无 usage）升级后被 accrue：usage 只有增量，与 tokensUsed 不等 → 只给总量。
    const legacy = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), tokensUsed: 100 }
    expect(buildToolResult(legacy)).not.toContain("cache read")

    const partial = {
      ...legacy,
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, // 和 2 ≠ 100
    }
    expect(buildToolResult(partial)).not.toContain("cache read")
  })

  test("omits an all-zero usage breakdown", () => {
    // 全新目标：usage 全 0，报出 "cache read 0, new work 0" 是无信息噪声。
    expect(buildToolResult(createGoal({ goalId: "g1", objective: "o", now: 0 }))).not.toContain("cache read")
  })

  test("includes the full objective", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "x".repeat(5000), now: 0 }) }
    expect(buildToolResult(goal)).toContain("x".repeat(5000))
  })

  test("omits lines with nothing to report", () => {
    const text = buildToolResult(createGoal({ goalId: "g1", objective: "o", now: 0 }))
    expect(text).not.toContain("Active work")
    expect(text).not.toContain("Auto-continues")
    expect(text).not.toContain("Blocker")
    expect(text).not.toContain("Last error")
  })

  test("reports the elapsed active work when non-zero", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), timeUsedSeconds: 750 }
    expect(buildToolResult(goal)).toContain("Active work: 12m 30s")
  })

  test("reports the accumulated auto-continue count", () => {
    const goal = { ...createGoal({ goalId: "g1", objective: "o", now: 0 }), continuations: 3 }
    expect(buildToolResult(goal)).toContain("Auto-continues: 3")
  })

  test("reports the blocker key, streak and text", () => {
    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      blockerKey: "missing-key",
      blockerText: "no API key",
      blockerStreak: 2,
    }
    expect(buildToolResult(goal)).toContain('Blocker: "missing-key" reported 2x — no API key')
  })

  test("reports lastError only when present", () => {
    expect(buildToolResult(createGoal({ goalId: "g1", objective: "o", now: 0 }))).not.toContain("Last error")

    const goal = {
      ...createGoal({ goalId: "g1", objective: "o", now: 0 }),
      status: "usage-limited" as const,
      lastError: { type: "provider.quota", message: "weekly usage limit", at: 7 },
    }
    expect(buildToolResult(goal)).toContain("Last error: provider.quota: weekly usage limit")
  })
})
