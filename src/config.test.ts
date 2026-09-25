import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, resolveOptions } from "./config"

describe("resolveOptions", () => {
  test("empty input returns defaults", () => {
    expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  test("overrides are applied", () => {
    const options = resolveOptions({ blocked_threshold: 5, restricted_agents: ["plan", "review"], command_name: "g" })
    expect(options.blockedThreshold).toBe(5)
    expect(options.restrictedAgents).toEqual(["plan", "review"])
    expect(options.commandName).toBe("g")
  })

  test("rejects a non-positive integer", () => {
    expect(() => resolveOptions({ blocked_threshold: 0 })).toThrow(/blocked_threshold/)
    expect(() => resolveOptions({ empty_threshold: 1.5 })).toThrow(/empty_threshold/)
  })

  test("rejects a malformed restricted_agents", () => {
    expect(() => resolveOptions({ restricted_agents: "plan" })).toThrow(/restricted_agents/)
  })

  test("debug defaults on and can be turned off", () => {
    expect(DEFAULT_OPTIONS.debug).toBe(true)
    expect(DEFAULT_OPTIONS.debugCommandName).toBe("goal-debug")
    expect(resolveOptions({ debug: false, debug_command_name: "gdebug" })).toMatchObject({
      debug: false,
      debugCommandName: "gdebug",
    })
  })

  test("rejects a non-boolean debug", () => {
    expect(() => resolveOptions({ debug: "yes" })).toThrow(/debug/)
  })

  test("language is optional and normalized", () => {
    expect(resolveOptions({}).language).toBeUndefined()
    expect(resolveOptions({ language: "zh" }).language).toBe("zh-CN")
    expect(resolveOptions({ language: "zh_CN" }).language).toBe("zh-CN")
    expect(resolveOptions({ language: "EN" }).language).toBe("en")
    expect("language" in DEFAULT_OPTIONS).toBe(false)
  })

  test("rejects a malformed language", () => {
    expect(() => resolveOptions({ language: "fr" })).toThrow(/language/)
    expect(() => resolveOptions({ language: 1 })).toThrow(/language/)
  })
})
