import { describe, expect, test } from "bun:test"
import { isMissingSessionError } from "./session-exists"

describe("isMissingSessionError", () => {
  test("recognizes the real TaggedError shape for a missing session", () => {
    // 真机实测（插件侧探针写入 KV）：会话不存在时抛的是 Schema.TaggedError，**没有 status**：
    //   {"outcome":"threw","tag":"Session.NotFoundError","status":"","keys":"_tag,sessionID"}
    expect(isMissingSessionError({ _tag: "Session.NotFoundError", sessionID: "ses_x" })).toBe(true)
  })

  test("recognizes the schema error for a malformed id", () => {
    // 真机实测：{"tag":"SchemaError","message":"Expected a string starting with \"ses\""}
    expect(isMissingSessionError({ _tag: "SchemaError", issue: {} })).toBe(true)
  })

  test("accepts legacy http-shaped 404/400", () => {
    expect(isMissingSessionError({ status: 404 })).toBe(true)
    expect(isMissingSessionError({ status: 400 })).toBe(true)
  })

  test("keeps the record on anything else (宁可留，不可误删)", () => {
    expect(isMissingSessionError({ status: 500 })).toBe(false)
    expect(isMissingSessionError({ _tag: "SomeOtherError" })).toBe(false)
    expect(isMissingSessionError(new Error("boom"))).toBe(false)
    expect(isMissingSessionError(undefined)).toBe(false)
    expect(isMissingSessionError("nope")).toBe(false)
  })
})
