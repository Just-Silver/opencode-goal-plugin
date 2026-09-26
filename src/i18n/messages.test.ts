import { describe, expect, test } from "bun:test"
import en from "./en"
import zhCN from "./zh-CN"
import { MESSAGES, format, formatDuration, formatTokens, messagesFor, statusLabel, type MessageKey } from "./index"

const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort()

describe("catalogs", () => {
  test("en and zh-CN have the same keys", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  test("no value is empty", () => {
    for (const value of Object.values(en)) expect(value.length).toBeGreaterThan(0)
    for (const value of Object.values(zhCN)) expect(value.length).toBeGreaterThan(0)
  })

  test("each key uses the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(zhCN[key])).toEqual(placeholders(en[key]))
    }
  })

  test("zh-CN differs from en for every key (no untranslated copy)", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(zhCN[key]).not.toBe(en[key])
    }
  })

  test("every template renders without leftover placeholders when all placeholders are supplied", () => {
    for (const catalog of [en, zhCN]) {
      for (const value of Object.values(catalog)) {
        const params = Object.fromEntries(placeholders(value).map((name) => [name, "x"]))
        expect(format(value, params)).not.toMatch(/\{[a-zA-Z]+\}/)
      }
    }
  })
})

describe("format", () => {
  test("replaces known placeholders", () => {
    expect(format("Goal is {status}; nothing to pause.", { status: "paused" })).toBe("Goal is paused; nothing to pause.")
  })

  test("leaves unknown placeholders intact", () => {
    expect(format("a {x} b", {})).toBe("a {x} b")
  })

  test("stringifies numbers", () => {
    expect(format("tokens {n}", { n: 160 })).toBe("tokens 160")
  })

  test("does not interpret $& or $1 in the substituted text", () => {
    expect(format("obj: {objective}", { objective: "a $& b $1" })).toBe("obj: a $& b $1")
  })
})

describe("statusLabel", () => {
  test("maps statuses per language", () => {
    expect(statusLabel(MESSAGES.en, "active")).toBe("active")
    expect(statusLabel(MESSAGES["zh-CN"], "active")).toBe("进行中")
    expect(statusLabel(MESSAGES["zh-CN"], "usage-limited")).toBe("用量受限")
  })
})

describe("formatDuration", () => {
  test("human-readable, at most two units, zero low-order unit dropped", () => {
    expect(formatDuration(MESSAGES.en, 0)).toBe("0s")
    expect(formatDuration(MESSAGES.en, 45)).toBe("45s")
    expect(formatDuration(MESSAGES.en, 60)).toBe("1m")
    expect(formatDuration(MESSAGES.en, 750)).toBe("12m 30s")
    expect(formatDuration(MESSAGES.en, 3600)).toBe("1h")
    expect(formatDuration(MESSAGES.en, 7500)).toBe("2h 5m")
    expect(formatDuration(MESSAGES.en, 90000)).toBe("1d 1h")
  })

  test("localizes the units and the joiner", () => {
    expect(formatDuration(MESSAGES["zh-CN"], 45)).toBe("45秒")
    expect(formatDuration(MESSAGES["zh-CN"], 750)).toBe("12分30秒")
    expect(formatDuration(MESSAGES["zh-CN"], 7500)).toBe("2小时5分")
    expect(formatDuration(MESSAGES["zh-CN"], 90000)).toBe("1天1小时")
    expect(formatDuration(MESSAGES["zh-CN"], 86400)).toBe("1天")
  })

  test("floors fractions and clamps negatives", () => {
    expect(formatDuration(MESSAGES.en, 59.9)).toBe("59s")
    expect(formatDuration(MESSAGES.en, -5)).toBe("0s")
  })
})

describe("formatTokens", () => {
  test("0 and sub-1000 stay verbatim", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(7)).toBe("7")
    expect(formatTokens(500)).toBe("500")
    expect(formatTokens(999)).toBe("999")
  })

  test("compacts by magnitude with trimming, no space before the unit", () => {
    expect(formatTokens(1000)).toBe("1K")
    expect(formatTokens(1250)).toBe("1.25K")
    expect(formatTokens(9999)).toBe("10K")
    expect(formatTokens(12345)).toBe("12.3K")
    expect(formatTokens(100000)).toBe("100K")
    expect(formatTokens(1234567)).toBe("1.23M")
    expect(formatTokens(100000000)).toBe("100M")
    expect(formatTokens(1500000000)).toBe("1.5B")
    expect(formatTokens(2000000000000)).toBe("2T")
  })

  test("never rounds up across a magnitude (no \"1000K\")", () => {
    expect(formatTokens(999999)).toBe("999K")
    expect(formatTokens(999999999)).toBe("999M")
  })

  test("floors fractions and clamps negatives", () => {
    expect(formatTokens(1500.9)).toBe("1.5K")
    expect(formatTokens(-5)).toBe("0")
  })
})

describe("messagesFor", () => {
  test("returns the catalog for a language", () => {
    expect(messagesFor("en")).toBe(en)
    expect(messagesFor("zh-CN")).toBe(zhCN)
  })
})
