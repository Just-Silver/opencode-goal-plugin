import { describe, expect, test } from "bun:test"
import { messagesFor } from "../i18n"
import { clampNotice, noticeLine } from "./notice"

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

  test("Infinity disables clipping and keeps the full detail", () => {
    const long = "x".repeat(200)
    expect(noticeLine("Goal request", long, Number.POSITIVE_INFINITY)).toBe(`Goal request · ${long}`)
  })
})

describe("clampNotice", () => {
  const messages = messagesFor("en")

  test("keeps a short message untouched", () => {
    expect(clampNotice("a\nb", messages)).toBe("a\nb")
  })

  test("keeps a message at exactly the row budget", () => {
    const message = ["a", "b", "c"].join("\n")
    expect(clampNotice(message, messages, 3, 54)).toBe(message)
  })

  test("folds overflowing lines into a marker that counts the hidden ones", () => {
    const message = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n")
    const result = clampNotice(message, messages, 5, 54)
    expect(result).toBe(["line 0", "line 1", "line 2", "line 3", "line 4", "… +10 more lines"].join("\n"))
  })

  test("counts wrapped rows, not just logical lines", () => {
    const long = "x".repeat(120) // 120 列 / 54 → 3 个显示行
    const message = [long, "tail"].join("\n")
    expect(clampNotice(message, messages, 3, 54)).toBe([long, "… +1 more lines"].join("\n"))
  })
})
