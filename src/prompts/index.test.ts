import { describe, expect, test } from "bun:test"
import { blockedWrapUp, budgetLimitPrompt, continuationTrigger, goalCommandPrompt, goalContext, xmlEscape } from "./index"
import { createGoal } from "../model/goal"

const goal = createGoal({ goalId: "g1", objective: "ship <it> & verify", now: 0, tokenBudget: 500 })

describe("xmlEscape", () => {
  test("escapes the three XML metacharacters", () => {
    expect(xmlEscape("<a> & <b>")).toBe("&lt;a&gt; &amp; &lt;b&gt;")
  })
})

describe("goalContext", () => {
  test("carries the escaped objective, status, budget, and the completion audit", () => {
    const text = goalContext(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("&lt;it&gt; &amp; verify")
    expect(text).toContain("Status: active")
    expect(text).toContain("Token budget: 500")
    expect(text).toContain("Completion audit")
    expect(text).toContain('op "complete"')
    expect(text).toContain('"budget"')
  })

  test("truncates a long objective and points at the get op", () => {
    const long = { ...goal, objective: "z".repeat(10) }
    const text = goalContext(long, { maxObjectiveChars: 4 })
    expect(text).toContain("zzzz")
    expect(text).not.toContain("zzzzz")
    expect(text).toContain('op "get"')
  })

  test("reports the current status so a non-active goal is never silently continued", () => {
    const paused = { ...goal, status: "paused" as const }
    expect(goalContext(paused, { maxObjectiveChars: 4000 })).toContain("Status: paused")
  })
})

describe("continuationTrigger", () => {
  test("is a single short line: the goal context travels in the system prompt instead", () => {
    const text = continuationTrigger()
    expect(text).not.toContain("\n")
    expect(text.length).toBeLessThan(200)
  })
})

describe("other templates", () => {
  test("budgetLimitPrompt is a wrap-up instruction", () => {
    expect(budgetLimitPrompt(goal, { maxObjectiveChars: 4000 })).toContain("budget")
    expect(budgetLimitPrompt(goal, { maxObjectiveChars: 4000 })).toContain('op "budget"')
  })

  test("blockedWrapUp names the blocker", () => {
    const blocked = { ...goal, status: "blocked" as const, blockerKey: "no-api-key", blockerStreak: 3 }
    expect(blockedWrapUp(blocked)).toContain("no-api-key")
  })

  test("goalCommandPrompt treats the argument as untrusted data", () => {
    const text = goalCommandPrompt("build the thing")
    expect(text).toContain("build the thing")
    expect(text).toContain("goal")
  })
})
