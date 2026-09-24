import { describe, expect, test } from "bun:test"
import { isRestrictedAgent } from "./plan"

describe("isRestrictedAgent", () => {
  test("matches by exact agent id", () => {
    expect(isRestrictedAgent("plan", ["plan"])).toBe(true)
    expect(isRestrictedAgent("build", ["plan"])).toBe(false)
    expect(isRestrictedAgent("plan", [])).toBe(false)
  })
})
