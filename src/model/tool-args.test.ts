import { describe, expect, test } from "bun:test"
import { parseToolArgs } from "./tool-args"

describe("parseToolArgs", () => {
  test("requires a known op", () => {
    expect(parseToolArgs({})).toEqual({ ok: false, message: expect.stringContaining("op") })
    expect(parseToolArgs({ op: "explode" })).toEqual({ ok: false, message: expect.stringContaining("op") })
  })

  test("maps snake_case keys and accepts a create call", () => {
    expect(parseToolArgs({ op: "create", objective: "do it", token_budget: 500 })).toEqual({
      ok: true,
      args: { op: "create", objective: "do it", tokenBudget: 500 },
    })
  })

  test("accepts token_budget 0 (means no budget) but rejects negatives and fractions", () => {
    expect(parseToolArgs({ op: "create", token_budget: 0 })).toEqual({ ok: true, args: { op: "create", tokenBudget: 0 } })
    for (const token_budget of [-1, 1.5])
      expect(parseToolArgs({ op: "create", token_budget })).toEqual({
        ok: false,
        message: expect.stringContaining("token_budget"),
      })
  })

  test("accepts a block call", () => {
    expect(parseToolArgs({ op: "block", blocker_key: "no-key", blocker: "missing credentials" })).toEqual({
      ok: true,
      args: { op: "block", blockerKey: "no-key", blocker: "missing credentials" },
    })
  })

  test("rejects a non-object", () => {
    expect(parseToolArgs("nope")).toEqual({ ok: false, message: expect.stringContaining("object") })
  })
})
