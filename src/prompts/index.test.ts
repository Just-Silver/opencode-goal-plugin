import { describe, expect, test } from "bun:test"
import { blockedWrapUp, budgetLimitPrompt, compactionSnapshot, continuationTrigger, goalContext, rewriteStoppedNote, stopWrapUpPrompt, xmlEscape } from "./index"
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
    expect(text).toContain('"get"')
    expect(text).toContain('"rewrite"')
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

  test("forbids the blocking question tool and names the blocker escape hatch", () => {
    const text = goalContext(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("Autonomy")
    expect(text).toContain("question tool is unavailable")
    expect(text).toContain('op "block"')
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
  test("budgetLimitPrompt is a wrap-up instruction that never points at a removed op", () => {
    const text = budgetLimitPrompt(goal, { maxObjectiveChars: 4000 })
    expect(text).toContain("token budget")
    expect(text).toContain("/goal-budget")
    // budget op 已从模型工具移除；提示词不能引用不存在的 op。
    expect(text).not.toContain('op "budget"')
  })

  test("rewriteStoppedNote tells the model the goal will not auto-continue", () => {
    expect(rewriteStoppedNote("paused")).toContain("paused")
    expect(rewriteStoppedNote("paused")).toContain("/goal-resume")
    expect(rewriteStoppedNote("budget-limited")).toContain("/goal-budget")
  })

  test("blockedWrapUp names the blocker", () => {
    const blocked = { ...goal, status: "blocked" as const, blockerKey: "no-api-key", blockerStreak: 3 }
    expect(blockedWrapUp(blocked)).toContain("no-api-key")
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
