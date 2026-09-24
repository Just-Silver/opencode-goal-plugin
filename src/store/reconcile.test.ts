import { describe, expect, test } from "bun:test"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "./repository"
import { reconcile } from "./reconcile"

function memoryStorage(): StorageLike {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan({ prefix }) {
      return { entries: [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
    },
  }
}

const now = 10_000_000
const guardMs = 5 * 60 * 1000

describe("reconcile", () => {
  test("removes records whose session is gone and guard elapsed", async () => {
    const repo = createRepository(memoryStorage())
    await repo.save("ses_old", createGoal({ goalId: "g1", objective: "o", now: now - guardMs - 1 }))
    const result = await reconcile({ repo, sessionExists: async () => false, guardMs, now })
    expect(result.removed).toEqual(["ses_old"])
    expect(await repo.load("ses_old")).toBeUndefined()
  })

  test("keeps records inside the guard window even if the session is missing", async () => {
    const repo = createRepository(memoryStorage())
    await repo.save("ses_new", createGoal({ goalId: "g1", objective: "o", now: now - 1000 }))
    const result = await reconcile({ repo, sessionExists: async () => false, guardMs, now })
    expect(result.removed).toEqual([])
    expect(await repo.load("ses_new")).toBeDefined()
  })

  test("keeps records whose session still exists", async () => {
    const repo = createRepository(memoryStorage())
    await repo.save("ses_live", createGoal({ goalId: "g1", objective: "o", now: now - guardMs - 1 }))
    const result = await reconcile({ repo, sessionExists: async () => true, guardMs, now })
    expect(result.removed).toEqual([])
  })

  test("keeps a record when the existence probe throws", async () => {
    const repo = createRepository(memoryStorage())
    await repo.save("ses_live", createGoal({ goalId: "g1", objective: "o", now: now - guardMs - 1 }))
    const result = await reconcile({
      repo,
      sessionExists: async () => {
        throw new Error("host unavailable")
      },
      guardMs,
      now,
    })
    expect(result.removed).toEqual([])
    expect(await repo.load("ses_live")).toBeDefined()
  })

  test("returns an empty result when listing throws", async () => {
    const base = createRepository(memoryStorage())
    await base.save("ses_old", createGoal({ goalId: "g1", objective: "o", now: now - guardMs - 1 }))
    const repo = { ...base, listAll: async () => { throw new Error("scan down") } }
    const result = await reconcile({ repo, sessionExists: async () => false, guardMs, now })
    expect(result.removed).toEqual([])
    expect(await base.load("ses_old")).toBeDefined()
  })

  test("keeps a record when remove throws and keeps going", async () => {
    const base = createRepository(memoryStorage())
    await base.save("ses_old", createGoal({ goalId: "g1", objective: "o", now: now - guardMs - 1 }))
    const repo = { ...base, remove: async () => { throw new Error("kv down") } }
    const result = await reconcile({ repo, sessionExists: async () => false, guardMs, now })
    expect(result.removed).toEqual([])
    expect(await base.load("ses_old")).toBeDefined()
  })
})
