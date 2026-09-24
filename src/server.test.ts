import { describe, expect, test } from "bun:test"
import plugin from "./server"

const ORPHAN = {
  version: 1,
  goalId: "g",
  objective: "o",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  blockerStreak: 0,
  emptyStreak: 0,
  createdAt: 0,
  updatedAt: 0,
}

function mockCtx(get: () => Promise<unknown>) {
  const store = new Map<string, unknown>()
  const removed: string[] = []
  const commands: Array<{ name: string }> = []
  const tools: Array<{ name: string }> = []
  const hooks: string[] = []
  const storage = {
    async get(key: string) {
      return store.get(key)
    },
    async set(key: string, value: unknown) {
      store.set(key, value)
    },
    async remove(key: string) {
      removed.push(key)
      store.delete(key)
    },
    async scan({ prefix }: { prefix: string }) {
      return {
        entries: [...store.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }
    },
  }
  const ctx = {
    options: {},
    storage,
    command: {
      transform: async (cb: (editor: { add: (def: { name: string }) => void }) => void) => {
        cb({ add: (def) => commands.push(def) })
      },
    },
    tool: {
      transform: async (cb: (editor: { add: (tool: { name: string }) => void }) => void) => {
        cb({ add: (tool) => tools.push(tool) })
      },
    },
    session: {
      hook: async (name: string) => {
        hooks.push(name)
      },
      prompt: async () => ({}),
      synthetic: async () => ({}),
      get,
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
  }
  return { store, removed, commands, tools, hooks, ctx }
}

const missing = async (): Promise<unknown> => {
  throw Object.assign(new Error("not found"), { status: 404 })
}

const errored = async (): Promise<unknown> => {
  throw Object.assign(new Error("boom"), { status: 500 })
}

describe("server", () => {
  test("exports a plugin definition with an id and a setup function", () => {
    expect(plugin.id).toBe("opencode-goal")
    expect(typeof plugin.setup).toBe("function")
  })

  test("setup wires the command, the tool, both hooks, and reconciles orphans", async () => {
    const env = mockCtx(missing)
    env.store.set("goal:ses_orphan", ORPHAN)

    const cleanup = await plugin.setup(env.ctx as never)
    expect(env.commands[0]?.name).toBe("goal")
    expect(env.tools[0]?.name).toBe("goal")
    expect(env.hooks).toEqual(["context", "compaction"])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(env.removed).toContain("goal:ses_orphan")
    expect(env.store.has("goal:ses_orphan")).toBe(false)

    if (typeof cleanup === "function") await cleanup()
  })

  test("keeps a record when the session probe fails with a non-404 error", async () => {
    const env = mockCtx(errored)
    env.store.set("goal:ses_orphan", ORPHAN)

    const cleanup = await plugin.setup(env.ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(env.removed).toEqual([])
    expect(env.store.has("goal:ses_orphan")).toBe(true)

    if (typeof cleanup === "function") await cleanup()
  })
})
