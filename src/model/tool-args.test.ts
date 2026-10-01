import { describe, expect, test } from "bun:test"
import { parseToolArgs } from "./tool-args"

describe("parseToolArgs", () => {
  test("requires a known op", () => {
    expect(parseToolArgs({})).toEqual({ ok: false, message: expect.stringContaining("op") })
    expect(parseToolArgs({ op: "explode" })).toEqual({ ok: false, message: expect.stringContaining("op") })
  })

  test("rejects the ops that are no longer model-callable", () => {
    // 创建 / 恢复 / 删除 / 改预算归用户命令，模型工具不再接受。
    for (const op of ["create", "resume", "drop", "budget"])
      expect(parseToolArgs({ op })).toEqual({ ok: false, message: expect.stringContaining("op") })
  })

  test("accepts a rewrite call", () => {
    expect(parseToolArgs({ op: "rewrite", objective: "new goal" })).toEqual({
      ok: true,
      args: { op: "rewrite", objective: "new goal" },
    })
  })

  test("accepts get and complete", () => {
    expect(parseToolArgs({ op: "get" })).toEqual({ ok: true, args: { op: "get" } })
    expect(parseToolArgs({ op: "complete" })).toEqual({ ok: true, args: { op: "complete" } })
  })

  test("accepts a block call", () => {
    expect(parseToolArgs({ op: "block", blocker_key: "no-key", blocker: "missing credentials" })).toEqual({
      ok: true,
      args: { op: "block", blockerKey: "no-key", blocker: "missing credentials" },
    })
  })

  test("ignores a token_budget field (no longer a tool parameter)", () => {
    expect(parseToolArgs({ op: "rewrite", objective: "x", token_budget: 500 })).toEqual({
      ok: true,
      args: { op: "rewrite", objective: "x" },
    })
  })

  test("rejects a non-object", () => {
    expect(parseToolArgs("nope")).toEqual({ ok: false, message: expect.stringContaining("object") })
  })
})
