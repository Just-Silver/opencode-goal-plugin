import { describe, expect, test } from "bun:test"
import { noticeLine } from "./notice"

describe("noticeLine", () => {
  test("joins the label and a flattened detail", () => {
    expect(noticeLine("Goal request", "ship\n  the   release")).toBe("Goal request · ship the release")
  })

  test("keeps the bare label when the detail is blank", () => {
    expect(noticeLine("Goal request", "   \n ")).toBe("Goal request")
  })

  test("truncates a long detail with a single ellipsis", () => {
    const line = noticeLine("Goal request", "x".repeat(100), 20)
    expect(line).toBe(`Goal request · ${"x".repeat(19)}…`)
  })

  test("does not truncate a detail at exactly the limit", () => {
    expect(noticeLine("L", "y".repeat(10), 10)).toBe(`L · ${"y".repeat(10)}`)
  })
})
