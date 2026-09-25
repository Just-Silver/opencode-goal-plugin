import { describe, expect, test } from "bun:test"
import en from "./en"
import zhCN from "./zh-CN"
import { MESSAGES, format, messagesFor, statusLabel, type MessageKey } from "./index"

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

describe("messagesFor", () => {
  test("returns the catalog for a language", () => {
    expect(messagesFor("en")).toBe(en)
    expect(messagesFor("zh-CN")).toBe(zhCN)
  })
})
