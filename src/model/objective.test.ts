import { describe, expect, test } from "bun:test"
import { normalizeObjective } from "./objective"

describe("normalizeObjective", () => {
  test("trims and accepts a normal objective", () => {
    expect(normalizeObjective("  ship the release  ", 4000)).toEqual({
      ok: true,
      objective: "ship the release",
      injection: "ship the release",
    })
  })

  test("rejects blank input", () => {
    expect(normalizeObjective("   \n\t ", 4000)).toEqual({ ok: false, reason: "empty" })
  })

  test("keeps the full text but truncates the injection above the limit", () => {
    const raw = "x".repeat(10)
    const result = normalizeObjective(raw, 4)
    expect(result).toEqual({ ok: true, objective: raw, injection: "xxxx" })
  })
})
