import { describe, expect, test } from "bun:test"
import { goalKey, isSessionID, parseGoalKey } from "./keys"

describe("keys", () => {
  test("round-trips a session id", () => {
    expect(parseGoalKey(goalKey("ses_abc"))).toBe("ses_abc")
  })

  test("rejects foreign and empty keys", () => {
    expect(parseGoalKey("other:ses_abc")).toBeUndefined()
    expect(parseGoalKey("goal:")).toBeUndefined()
  })

  test("recognizes host session ids (must start with ses)", () => {
    expect(isSessionID("ses_f2c8fc1edffeVIlIcnWiK5gAge")).toBe(true)
    // 早期探针留下的伪造键：宿主 API 会对它们报 400，因此永远不可能是真实会话。
    expect(isSessionID("__diag__/C__Users_13178")).toBe(false)
    expect(isSessionID("")).toBe(false)
  })
})
