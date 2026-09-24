import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS } from "../config"
import { createGoal } from "../model/goal"
import { createRepository, type StorageLike } from "../store/repository"
import { createDebug } from "./debug"
import type { GoalDeps } from "./deps"
import { createEventRouter } from "./events"

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

const OWN = "own"

function makeDeps(): GoalDeps {
  return {
    repo: createRepository(memoryStorage()),
    options: { ...DEFAULT_OPTIONS },
    now: () => 1000,
    newGoalId: () => "g1",
    isRestricted: () => false,
    locationDirectory: OWN,
    sessionDirectory: async () => OWN,
  }
}

function makeDebug(deps: GoalDeps) {
  const router = createEventRouter(deps, { onIdle: async () => false })
  return { debug: createDebug(deps, { pluginId: "opencode-goal", snapshot: () => router.diagnostics() }), router }
}

describe("createDebug", () => {
  test("env reports the instance location, the session directory and the verdict", async () => {
    const { debug } = makeDebug(makeDeps())
    const text = await debug.render("env", "ses_1")
    expect(text).toContain("instance location: own")
    expect(text).toContain("session directory: own")
    expect(text).toContain("belongs to this instance: yes")
    // notice 行是纯文本渲染：输出里不能有 Markdown 语法（### / 反引号）。
    expect(text).not.toContain("###")
    expect(text).not.toContain("`")
  })

  test("env flags a session that belongs to another location", async () => {
    const deps = { ...makeDeps(), sessionDirectory: async () => "elsewhere" }
    const { debug } = makeDebug(deps)
    const text = await debug.render("env", "ses_1")
    expect(text).toContain("belongs to this instance: no")
  })

  test("events lists tracked events with the ownership decision", async () => {
    const { debug, router } = makeDebug(makeDeps())
    await router.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } })
    await router.handle({
      type: "session.step.started",
      location: { directory: "elsewhere" },
      data: { sessionID: "ses_2", agent: "build", started: 0 },
    })
    const text = await debug.render("events", "ses_1")
    expect(text).toContain("session.execution.started")
    expect(text).toContain("allow")
    expect(text).toContain("drop-other-location")
    // 不再用 Markdown 表格（notice 行不渲染 Markdown，竖线会原样显示）。
    expect(text).not.toContain("|")
    expect(text).not.toContain("###")
  })

  test("sessions lists stored goal records", async () => {
    const deps = makeDeps()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "finish X", now: 0 }))
    const { debug } = makeDebug(deps)
    const text = await debug.render("sessions", "ses_1")
    expect(text).toContain("finish X")
    expect(text).toContain("active")
  })

  test("state reports the in-memory turn state", async () => {
    const { debug, router } = makeDebug(makeDeps())
    await router.handle({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "build" } })
    const text = await debug.render("state", "ses_1")
    expect(text).toContain("agent: build")
    expect(text).toContain("goal: (none)")
  })

  test("empty or unknown subcommands fall back to usage (one short line)", async () => {
    const { debug } = makeDebug(makeDeps())
    const empty = await debug.render("", "ses_1")
    expect(empty).toContain("opencode-goal debug")
    // 用法必须是一行：它会留在会话历史里。
    expect(empty.split("\n")).toHaveLength(1)
    const text = await debug.render("nope", "ses_1")
    expect(text).toContain("Unknown debug subcommand")
    expect(text).toContain("events")
  })
})
