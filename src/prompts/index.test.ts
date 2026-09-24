import { describe, expect, test } from "bun:test"
import { activeReminder, blockedWrapUp, budgetLimitPrompt, continuationPrompt, goalCommandPrompt, xmlEscape } from "./index"
import { createGoal } from "../model/goal"

const goal = createGoal({ goalId: "g1", objective: "ship <it> & verify", now: 0, tokenBudget: 500 })

describe("xmlEscape", () => {
  test("escapes the three XML metacharacters", () => {
    expect(xmlEscape("<a> & <b>")).toBe("&lt;a&gt; &amp; &lt;b&gt;")
  })
})

describe("continuationPrompt", () => {
  test("embeds the escaped objective, budget, and the completion audit", () => {
    const text = continuationPrompt(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("&lt;it&gt; &amp; verify")
    expect(text).toContain("Token budget: 500")
    expect(text).toContain("Completion audit")
    expect(text).toContain('op "complete"')
  })

  test("truncates a long objective and points at the get op", () => {
    const long = { ...goal, objective: "z".repeat(10) }
    const text = continuationPrompt(long, { maxObjectiveChars: 4 })
    expect(text).toContain("zzzz")
    expect(text).not.toContain("zzzzz")
    expect(text).toContain('op "get"')
  })
})

describe("other templates", () => {
  test("activeReminder tells the model to check before acting", () => {
    expect(activeReminder()).toContain('op "get"')
  })

  test("budgetLimitPrompt is a wrap-up instruction", () => {
    expect(budgetLimitPrompt(goal, { maxObjectiveChars: 4000 })).toContain("budget")
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
