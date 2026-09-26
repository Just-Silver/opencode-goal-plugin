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
  const commands: Array<{ name: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }> = []
  const tools: Array<{ name: string; options?: { codemode?: boolean } }> = []
  const hooks: string[] = []
  const synthetic: Array<Record<string, unknown>> = []
  const notices: Array<{ name: string; data: Record<string, unknown> }> = []
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
    options: { language: "en" },
    location: { directory: "test-location" },
    storage,
    command: {
      transform: async (
        cb: (editor: {
          add: (def: { name: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }) => void
        }) => void,
      ) => {
        cb({ add: (def) => commands.push(def) })
      },
    },
    tool: {
      transform: async (
        cb: (editor: { add: (tool: { name: string; options?: { codemode?: boolean } }) => void }) => void,
      ) => {
        cb({ add: (tool) => tools.push(tool) })
      },
    },
    session: {
      hook: async (name: string) => {
        hooks.push(name)
      },
      synthetic: async (input: Record<string, unknown>) => {
        synthetic.push(input)
        return {}
      },
      get,
    },
    event: {
      subscribe: () => (async function* () {})(),
    },
    rpc: {
      register: async () => ({
        dispose: async () => {},
        events: {
          emit: async (name: string, data: Record<string, unknown>) => {
            notices.push({ name, data })
          },
        },
      }),
    },
  }
  return { store, removed, commands, tools, hooks, synthetic, notices, ctx }
}

const missing = async (): Promise<unknown> => {
  throw Object.assign(new Error("not found"), { status: 404 })
}

const errored = async (): Promise<unknown> => {
  throw Object.assign(new Error("boom"), { status: 500 })
}

/**
 * 真机实测（插件侧探针写入 KV）：会话不存在时抛的是 Schema.TaggedError，**没有 `status`**——
 *   {"outcome":"threw","tag":"Session.NotFoundError","status":"","keys":"_tag,sessionID"}
 * 上面的 `missing` 用的是 `status: 404`（历史/HTTP 形态），那是真实插件 API **从不产生**的形状；
 * 只测它，真机上 reconcile 清不掉孤儿也发现不了。`missingReal` 就是当时漏掉的形状。
 */
const missingReal = async (): Promise<unknown> => {
  throw { _tag: "Session.NotFoundError", sessionID: "ses_orphan" }
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
    // 命令面：只有 `/goal <目标>` 会转发给模型；状态控制是独立命令（宿主没有子命令概念）。
    expect(env.commands.map((command) => command.name)).toEqual([
      "goal",
      "goal-status",
      "goal-rebuild",
      "goal-budget",
      "goal-pause",
      "goal-resume",
      "goal-clear",
      "goal-debug",
    ])
    expect(env.tools[0]?.name).toBe("goal")
    // 直连工具：不进 Code Mode 目录（否则模型要写 JS 才能调）。
    expect(env.tools[0]?.options?.codemode).toBe(false)
    // debug 默认开：额外注册只读的 goal_debug，让 agent 能自主诊断。
    expect(env.tools[1]?.name).toBe("goal_debug")
    expect(env.tools[1]?.options?.codemode).toBe(false)
    expect(env.hooks).toEqual(["context", "compaction"])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(env.removed).toContain("goal:ses_orphan")
    expect(env.store.has("goal:ses_orphan")).toBe(false)

    if (typeof cleanup === "function") await cleanup()
  })

  test("reconciles away an orphan whose probe throws the measured TaggedError shape", async () => {
    // 回归测试：真机上 reconcile 从来没清掉过孤儿，就是因为判定认的是 `status` 字段，而实测没有它。
    const env = mockCtx(missingReal)
    env.store.set("goal:ses_orphan", ORPHAN)

    const cleanup = await plugin.setup(env.ctx as never)
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

  test("reconciles away a record whose key is not a real session id", async () => {
    // 探针留下的脏键：宿主 API 会对这种 id 报 400。旧规则把非 404 都当“会话还在”，
    // 于是这类记录永远清不掉；现在按 id 形态直接判定为不存在。
    const env = mockCtx(errored)
    env.store.set("goal:__diag__/C__Users_13178", ORPHAN)

    const cleanup = await plugin.setup(env.ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(env.removed).toContain("goal:__diag__/C__Users_13178")
    expect(env.store.has("goal:__diag__/C__Users_13178")).toBe(false)

    if (typeof cleanup === "function") await cleanup()
  })

  test("the status command notifies via an RPC event and writes no session message", async () => {
    const env = mockCtx(missing)
    const cleanup = await plugin.setup(env.ctx as never)
    const command = env.commands.find((item) => item.name === "goal-status")
    expect(command).toBeDefined()

    await command!.execute({ sessionID: "ses_1", prompt: { text: "" } })

    // 回执走 RPC 事件 → TUI 弹窗；0 token（不写会话消息）。
    expect(env.notices).toHaveLength(1)
    expect(env.notices[0]?.name).toBe("notice")
    expect(env.notices[0]?.data).toMatchObject({ sessionID: "ses_1", title: "Goal" })
    expect(String(env.notices[0]?.data.message)).toContain("No goal")
    expect(env.synthetic).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("an objective is delivered as a resuming synthetic so the prompt never floods the transcript", async () => {
    const env = mockCtx(missing)
    const cleanup = await plugin.setup(env.ctx as never)
    const command = env.commands[0]

    await command!.execute({ sessionID: "ses_1", prompt: { text: "ship it" } })

    expect(env.synthetic).toHaveLength(1)
    const notice = env.synthetic[0] as { text?: string; description?: string; resume?: boolean }
    expect(notice.resume).toBe(true)
    expect(notice.text).toContain("ship it")
    // 完整 prompt 只给模型（text）；TUI 只显示 description 一行。
    expect(notice.description).toBe("Goal request · ship it")

    if (typeof cleanup === "function") await cleanup()
  })

  test("a stop notice is a resuming synthetic: localized line for the human, wrap-up prompt for the model", async () => {
    const env = mockCtx(missing)
    const cleanup = await plugin.setup(env.ctx as never)
    const command = env.commands.find((item) => item.name === "goal-budget")
    expect(command?.name).toBe("goal-budget")
    // 目标已用量远超新预算 → 设预算当场 budget-limited → 触发停摆回执。
    env.store.set("goal:ses_1", { ...ORPHAN, tokensUsed: 100 })

    await command!.execute({ sessionID: "ses_1", prompt: { text: "10" } })

    expect(env.synthetic).toHaveLength(1)
    const stop = env.synthetic[0] as { text?: string; description?: string; resume?: boolean }
    // **必须唤醒**：`resume: false` 的合成消息只会躺在收件箱里（转录不建行、模型读不到），
    // 真机表现就是「预算到了，人和模型都不知道」。
    expect(stop.resume).toBe(true)
    // 人看的是本地化的一行（落转录、不会像 toast 那样消失）；预算用尽要指向 `/goal-budget`（不是 resume）。
    expect(stop.description).toBe("Goal marked budget-limited. Raise it with /goal-budget to continue.")
    // 模型看的是收尾指令，不是那句「怎么恢复」的话。
    expect(stop.text).toContain("Do not call any tools")
    expect(stop.text).not.toContain("/goal-budget")

    if (typeof cleanup === "function") await cleanup()
  })

  test("the debug command reports its rendered output to the transcript", async () => {
    const env = mockCtx(missing)
    const cleanup = await plugin.setup(env.ctx as never)
    const command = env.commands.find((item) => item.name === "goal-debug")
    expect(command?.name).toBe("goal-debug")

    await command!.execute({ sessionID: "ses_1", prompt: { text: "env" } })

    expect(env.notices).toHaveLength(1)
    expect(env.notices[0]?.name).toBe("notice")
    expect(String(env.notices[0]?.data.message)).toContain("debug env")
    expect(env.synthetic).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })
})
