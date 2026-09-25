import { describe, expect, test } from "bun:test"
import { createGoal } from "./goal"
import { applyHostSignal, hostSignal } from "./signals"

describe("hostSignal", () => {
  test("maps provider.quota to usage-limited", () => {
    expect(hostSignal({ type: "provider.quota", message: "weekly usage limit reached" })).toEqual({
      status: "usage-limited",
      type: "provider.quota",
      message: "weekly usage limit reached",
    })
  })

  test("maps deterministic rejections to blocked", () => {
    for (const type of ["provider.auth", "provider.content-filter", "provider.invalid-request"]) {
      expect(hostSignal({ type, message: "x" })).toEqual({ status: "blocked", type, message: "x" })
    }
  })

  test("ignores excluded and unknown types", () => {
    for (const type of [
      "provider.no-route",
      "provider.timeout",
      "provider.unsupported-operation",
      "provider.rate-limit",
      "provider.internal",
      "provider.transport",
      "provider.invalid-output",
      "provider.unknown",
      "permission.rejected",
      "tool.execution",
      "aborted",
      "unknown",
    ])
      expect(hostSignal({ type, message: "x" })).toBeUndefined()
  })

  test("ignores malformed errors", () => {
    expect(hostSignal(undefined)).toBeUndefined()
    expect(hostSignal(null)).toBeUndefined()
    expect(hostSignal("provider.quota")).toBeUndefined()
    expect(hostSignal({})).toBeUndefined()
    expect(hostSignal({ type: 123 })).toBeUndefined()
    expect(hostSignal({ type: "" })).toBeUndefined()
  })

  test("defaults a missing or non-string message to an empty string", () => {
    expect(hostSignal({ type: "provider.quota" })).toEqual({ status: "usage-limited", type: "provider.quota", message: "" })
    expect(hostSignal({ type: "provider.quota", message: 5 })).toEqual({
      status: "usage-limited",
      type: "provider.quota",
      message: "",
    })
  })
})

describe("applyHostSignal", () => {
  const goal = createGoal({ goalId: "g1", objective: "o", now: 0 })
  const signal = { status: "usage-limited" as const, type: "provider.quota", message: "quota" }

  test("marks an active goal and records lastError", () => {
    const next = applyHostSignal(goal, 2000, signal)
    expect(next.status).toBe("usage-limited")
    expect(next.lastError).toEqual({ type: "provider.quota", message: "quota", at: 2000 })
    expect(next.updatedAt).toBe(2000)
  })

  test("upgrades a blocked goal without touching the model-reported blocker fields", () => {
    const blocked = { ...goal, status: "blocked" as const, blockerKey: "k", blockerText: "t", blockerStreak: 2 }
    const next = applyHostSignal(blocked, 2000, { status: "blocked" as const, type: "provider.auth", message: "auth" })
    expect(next.status).toBe("blocked")
    expect(next.lastError?.type).toBe("provider.auth")
    expect(next.blockerKey).toBe("k")
    expect(next.blockerText).toBe("t")
    expect(next.blockerStreak).toBe(2)
  })

  test("leaves non-active/non-blocked statuses untouched", () => {
    for (const status of ["paused", "complete", "usage-limited", "budget-limited"] as const) {
      const g = { ...goal, status }
      expect(applyHostSignal(g, 2000, signal)).toBe(g)
    }
  })
})
