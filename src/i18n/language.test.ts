import { describe, expect, test } from "bun:test"
import { resolveLanguage, systemLocale, toLanguage } from "./language"

describe("toLanguage", () => {
  test("maps zh variants to zh-CN", () => {
    expect(toLanguage("zh")).toBe("zh-CN")
    expect(toLanguage("zh-CN")).toBe("zh-CN")
    expect(toLanguage("zh-Hans-CN")).toBe("zh-CN")
    expect(toLanguage("ZH_CN")).toBe("zh-CN")
  })

  test("maps en variants to en", () => {
    expect(toLanguage("en")).toBe("en")
    expect(toLanguage("en-US")).toBe("en")
    expect(toLanguage("EN")).toBe("en")
  })

  test("returns undefined for unsupported or empty tags", () => {
    expect(toLanguage("fr")).toBeUndefined()
    expect(toLanguage("C")).toBeUndefined()
    expect(toLanguage("")).toBeUndefined()
    expect(toLanguage("   ")).toBeUndefined()
  })
})

describe("resolveLanguage", () => {
  test("explicit wins over the system locale", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en")
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN")
  })

  test("falls back to the system locale", () => {
    expect(resolveLanguage(undefined, "zh-CN")).toBe("zh-CN")
    expect(resolveLanguage(undefined, "en-GB")).toBe("en")
  })

  test("falls back to en for an unsupported locale", () => {
    expect(resolveLanguage(undefined, "fr")).toBe("en")
    expect(resolveLanguage(undefined, "")).toBe("en")
  })
})

describe("systemLocale", () => {
  test("returns a non-empty string", () => {
    expect(typeof systemLocale()).toBe("string")
    expect(systemLocale().length).toBeGreaterThan(0)
  })
})
