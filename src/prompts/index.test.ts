import { describe, expect, test } from "bun:test"
import { blockedWrapUp, budgetLimitPrompt, compactionSnapshot, continuationTrigger, goalCommandPrompt, goalContext, stopWrapUpPrompt, xmlEscape } from "./index"
import { createGoal } from "../model/goal"

const goal = createGoal({ goalId: "g1", objective: "ship <it> & verify", now: 0, tokenBudget: 500 })

describe("xmlEscape", () => {
  test("escapes the three XML metacharacters", () => {
    expect(xmlEscape("<a> & <b>")).toBe("&lt;a&gt; &amp; &lt;b&gt;")
  })
})

describe("goalContext", () => {
  test("carries the escaped objective and the completion audit, without volatile status/budget lines", () => {
    const text = goalContext(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("&lt;it&gt; &amp; verify")
    expect(text).toContain("Completion audit")
    expect(text).toContain('op "complete"')
    expect(text).toContain('"budget"')
    expect(text).not.toContain("Status:")
    expect(text).not.toContain("Tokens used")
    expect(text).not.toContain("Tokens remaining")
    expect(text).not.toContain("Token budget")
  })

  test("truncates a long objective and points at the get op", () => {
    const long = { ...goal, objective: "z".repeat(10) }
    const text = goalContext(long, { maxObjectiveChars: 4 })
    expect(text).toContain("zzzz")
    expect(text).not.toContain("zzzzz")
    expect(text).toContain('op "get"')
  })

  test("is byte-identical when only volatile counters change (prompt-cache stability)", () => {
    const later = { ...goal, tokensUsed: 247365, timeUsedSeconds: 40, continuations: 7 }
    expect(goalContext(later, { maxObjectiveChars: 4000 })).toBe(goalContext(goal, { maxObjectiveChars: 4000 }))
  })
})

describe("compactionSnapshot", () => {
  test("keeps status and objective but omits volatile budget lines", () => {
    const text = compactionSnapshot(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("<goal_snapshot>")
    expect(text).toContain("Status: active")
    expect(text).toContain("&lt;it&gt; &amp; verify")
    expect(text).not.toContain("Tokens used")
    expect(text).not.toContain("Tokens remaining")
    expect(text).not.toContain("Token budget")
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

  test("stopWrapUpPrompt names the reason, forbids more work, and forbids tool calls", () => {
    const budget = stopWrapUpPrompt("budget-limited")
    expect(budget).toContain("token budget")
    expect(budget).toContain("Do not continue the task")
    expect(budget).toContain("Do not call any tools")
    expect(stopWrapUpPrompt("usage-limited")).toContain("usage or quota limit")
    expect(stopWrapUpPrompt("blocked")).toContain("rejected the request")
  })
})
