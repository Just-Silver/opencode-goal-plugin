import type { GoalDeps } from "./deps"
import type { DebugEventRecord, DebugSnapshot } from "./events"

/** 调试专用的只读视图（由 events 路由提供）。 */
export interface DebugSource {
  readonly pluginId: string
  readonly snapshot: () => DebugSnapshot
}

export interface Debug {
  /** 渲染一次诊断输出（**纯文本**）；空 op 或未知 op 返回用法。 */
  render(op: string, sessionID: string): Promise<string>
}

export const DEBUG_OPS = ["env", "events", "sessions", "state"] as const

/**
 * 注意：这些文本最终走 `session.synthetic` 的 `description`，而 TUI 的 notice 行是
 * **纯文本渲染、不解析 Markdown**（`###`、`| 表格 |` 会原样显示，很难看）。
 * 所以这里一律输出裸文本，不要用 Markdown 语法。
 */
function usage(pluginId: string): string {
  return `${pluginId} debug — 用法: env | events | sessions | state`
}

function block(header: string, rows: readonly string[]): string {
  return [header, ...(rows.length === 0 ? ["(none)"] : rows)].join("\n")
}

function short(id: string, length = 16): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** 本地墙钟时间 `HH:mm:ss.SSS`（调试输出给人看，用本地时区而非 UTC）。 */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

async function renderEnv(deps: GoalDeps, source: DebugSource, sessionID: string): Promise<string> {
  const directory = await deps.sessionDirectory(sessionID)
  const verdict = directory === undefined ? "unknown" : directory === deps.locationDirectory ? "yes" : "no"
  return block(`${source.pluginId} debug env`, [
    `instance location: ${deps.locationDirectory}`,
    `session: ${sessionID}`,
    `session directory: ${directory ?? "(unknown)"}`,
    `belongs to this instance: ${verdict}`,
    `options: ${JSON.stringify(deps.options)}`,
  ])
}

function renderEvents(pluginId: string, events: readonly DebugEventRecord[]): string {
  const rows = events.map((event) =>
    [
      clock(event.at),
      event.type,
      event.sessionID === undefined ? "-" : short(event.sessionID),
      event.hasLocation ? short(event.location ?? "", 28) : "-",
      event.decision,
    ].join("  "),
  )
  return block(`${pluginId} debug events (last ${events.length})`, rows)
}

async function renderSessions(deps: GoalDeps, pluginId: string): Promise<string> {
  const all = await deps.repo.listAll()
  const rows = all.map(({ sessionID, goal }) =>
    [short(sessionID), goal.status, clip(goal.objective, 60), clock(goal.updatedAt)].join("  "),
  )
  return block(`${pluginId} debug sessions (${all.length})`, rows)
}

async function renderState(deps: GoalDeps, pluginId: string, sessionID: string, snapshot: DebugSnapshot): Promise<string> {
  const state = snapshot.sessions.find((item) => item.sessionID === sessionID)
  const goal = await deps.repo.load(sessionID)
  const cache = state?.sessionDirectory
  return block(`${pluginId} debug state`, [
    `session: ${sessionID}`,
    `turn open: ${state === undefined ? "(no tracked state)" : state.turnOpen}`,
    `agent: ${state?.agent ?? "unknown"}`,
    `session directory cache: ${cache === undefined || cache === null ? "(none)" : cache}`,
    `pending automatic: ${state === undefined ? "-" : state.pendingAutomatic}`,
    `pending background: ${state === undefined ? "-" : state.pendingBackground}`,
    `blocked this turn: ${state === undefined ? "-" : state.blockedThisTurn}`,
    `goal: ${goal === undefined ? "(none)" : `${goal.status}, emptyStreak=${goal.emptyStreak}, blockerStreak=${goal.blockerStreak}`}`,
  ])
}

/**
 * `/goal-debug` 的确定性入口：零 token、只读、不产生任何副作用。
 * 输出保持**短**且为纯文本：命令的唯一出口是往会话插一条消息，会留在历史里。
 */
export function createDebug(deps: GoalDeps, source: DebugSource): Debug {
  return {
    async render(rawOp, sessionID) {
      const op = rawOp.trim().toLowerCase()
      switch (op) {
        case "":
        case "help":
          return usage(source.pluginId)
        case "env":
          return renderEnv(deps, source, sessionID)
        case "events":
          return renderEvents(source.pluginId, source.snapshot().events)
        case "sessions":
          return renderSessions(deps, source.pluginId)
        case "state":
          return renderState(deps, source.pluginId, sessionID, source.snapshot())
        default:
          return `Unknown debug subcommand: ${op}\n${usage(source.pluginId)}`
      }
    },
  }
}
