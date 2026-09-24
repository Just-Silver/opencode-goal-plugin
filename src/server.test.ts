import { describe, expect, test } from "bun:test"
import plugin from "./server"

describe("server", () => {
  test("exports a plugin definition with an id and a setup function", () => {
    expect(plugin.id).toBe("opencode-goal")
    expect(typeof plugin.setup).toBe("function")
  })

  test("setup wires the command, the tool, both hooks, and reconciles orphans", async () => {
    const store = new Map<string, unknown>()
    const removed: string[] = []
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
    store.set("goal:ses_orphan", {
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
    })

    const commands: Array<{ name: string }> = []
    const tools: Array<{ name: string }> = []
    const hooks: string[] = []
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
        get: async () => {
          throw Object.assign(new Error("not found"), { status: 404 })
        },
      },
      event: {
        subscribe: () => (async function* () {})(),
      },
    }

    const cleanup = await plugin.setup(ctx as never)
    expect(commands[0]?.name).toBe("goal")
    expect(tools[0]?.name).toBe("goal")
    expect(hooks).toEqual(["context", "compaction"])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(removed).toContain("goal:ses_orphan")

    if (typeof cleanup === "function") await cleanup()
  })
})
