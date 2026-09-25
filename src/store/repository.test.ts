import { describe, expect, test } from "bun:test"
import { createGoal } from "../model/goal"
import { KEY_PREFIX, goalKey, parseGoalKey } from "./keys"
import { createRepository, decodeGoal, type StorageLike } from "./repository"

function memoryStorage(): StorageLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    // 宿主语义：after 为排他游标（key > after），next 为本页最后一个 key（仅供有后续时返回）。
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after === undefined ? 0 : keys.findIndex((key) => key > after)
      const from = start < 0 ? keys.length : start
      const slice = keys.slice(from, from + limit)
      const next = slice[slice.length - 1]
      return {
        entries: slice.map((key) => ({ key, value: map.get(key) })),
        ...(keys.length > from + limit && next !== undefined ? { next } : {}),
      }
    },
  }
}

describe("keys", () => {
  test("round-trips a session id", () => {
    expect(goalKey("ses_abc")).toBe(`${KEY_PREFIX}ses_abc`)
    expect(parseGoalKey(`${KEY_PREFIX}ses_abc`)).toBe("ses_abc")
  })

  test("rejects foreign and empty keys", () => {
    expect(parseGoalKey("other:x")).toBeUndefined()
    expect(parseGoalKey(KEY_PREFIX)).toBeUndefined()
  })
})

describe("repository", () => {
  test("saves, loads, and removes a session goal", async () => {
    const repo = createRepository(memoryStorage())
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    await repo.save("ses_1", goal)
    expect(await repo.load("ses_1")).toEqual(goal)
    await repo.remove("ses_1")
    expect(await repo.load("ses_1")).toBeUndefined()
  })

  test("listAll pages through scan results", async () => {
    const storage = memoryStorage()
    const repo = createRepository(storage)
    await repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 1 }))
    await repo.save("ses_2", createGoal({ goalId: "g2", objective: "o", now: 1 }))
    const all = await repo.listAll()
    expect(all.map((item) => item.sessionID).sort()).toEqual(["ses_1", "ses_2"])
  })

  test("listAll follows next across multiple scan pages", async () => {
    const storage = memoryStorage()
    const repo = createRepository(storage)
    for (let i = 0; i < 5; i++) await repo.save(`ses_${i}`, createGoal({ goalId: `g${i}`, objective: "o", now: 1 }))
    const scan = storage.scan.bind(storage)
    storage.scan = (options) => scan({ ...options, limit: 2 })
    const all = await repo.listAll()
    expect(all.map((item) => item.sessionID).sort()).toEqual(["ses_0", "ses_1", "ses_2", "ses_3", "ses_4"])
  })

  test("listAll skips a record that fails to decode", async () => {
    const storage = memoryStorage()
    const repo = createRepository(storage)
    await repo.save("ses_ok", createGoal({ goalId: "g1", objective: "o", now: 1 }))
    storage.map.set(`${KEY_PREFIX}ses_bad`, { version: 99 })
    const all = await repo.listAll()
    expect(all.map((item) => item.sessionID)).toEqual(["ses_ok"])
  })

  test("decodeGoal rejects a wrong version or a malformed record", () => {
    expect(decodeGoal({ version: 99 })).toBeUndefined()
    expect(decodeGoal({ version: 1, goalId: "g" })).toBeUndefined()
    expect(decodeGoal(null)).toBeUndefined()
  })

  test("decodeGoal keeps an optional usage breakdown", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 } })
    expect(decoded?.usage).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })
  })

  test("decodeGoal drops a malformed usage but keeps the goal", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, usage: { input: "nope" } })
    expect(decoded).toBeDefined()
    expect(decoded?.usage).toBeUndefined()
    expect(decoded?.goalId).toBe("g1")
  })

  test("decodeGoal accepts a legacy record without usage", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const legacy: Record<string, unknown> = { ...goal }
    delete legacy.usage
    const decoded = decodeGoal(legacy)
    expect(decoded?.usage).toBeUndefined()
    expect(decoded?.tokensUsed).toBe(0)
  })

  test("decodeGoal keeps an optional lastError", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, lastError: { type: "provider.quota", message: "q", at: 9 } })
    expect(decoded?.lastError).toEqual({ type: "provider.quota", message: "q", at: 9 })
  })

  test("decodeGoal drops a malformed lastError but keeps the goal", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, lastError: { type: 5 } })
    expect(decoded).toBeDefined()
    expect(decoded?.lastError).toBeUndefined()
    expect(decoded?.goalId).toBe("g1")
  })

  test("decodeGoal drops both malformed optional fields at once", () => {
    const goal = createGoal({ goalId: "g1", objective: "o", now: 1 })
    const decoded = decodeGoal({ ...goal, usage: { input: "nope" }, lastError: { at: "nope" } })
    expect(decoded).toBeDefined()
    expect(decoded?.usage).toBeUndefined()
    expect(decoded?.lastError).toBeUndefined()
    expect(decoded?.goalId).toBe("g1")
  })
})
