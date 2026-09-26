import { format, type Messages } from "../i18n/messages"
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
function usage(messages: Messages, pluginId: string): string {
  return format(messages["debug.usage"], { pluginId })
}

function block(header: string, rows: readonly string[], messages: Messages): string {
  return [header, ...(rows.length === 0 ? [messages["debug.none"]] : rows)].join("\n")
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
  const messages = deps.messages
  const directory = await deps.sessionDirectory(sessionID)
  const verdict =
    directory === undefined
      ? messages["debug.unknown"]
      : directory === deps.locationDirectory
        ? messages["debug.yes"]
        : messages["debug.no"]
  return block(
    format(messages["debug.env.header"], { pluginId: source.pluginId }),
    [
      format(messages["debug.env.instanceLocation"], { dir: deps.locationDirectory }),
      format(messages["debug.env.session"], { id: sessionID }),
      format(messages["debug.env.sessionDirectory"], { dir: directory ?? messages["debug.unknownValue"] }),
      format(messages["debug.env.belongs"], { verdict }),
      format(messages["debug.env.options"], { json: JSON.stringify(deps.options) }),
    ],
    messages,
  )
}

function renderEvents(pluginId: string, messages: Messages, events: readonly DebugEventRecord[]): string {
  const rows = events.map((event) =>
    [
      clock(event.at),
      event.type,
      event.sessionID === undefined ? "-" : short(event.sessionID),
      event.hasLocation ? short(event.location ?? "", 28) : "-",
      event.decision,
    ].join("  "),
  )
  return block(format(messages["debug.events.header"], { pluginId, n: events.length }), rows, messages)
}

async function renderSessions(deps: GoalDeps, pluginId: string): Promise<string> {
  const messages = deps.messages
  const all = await deps.repo.listAll()
  const rows = all.map(({ sessionID, goal }) =>
    [short(sessionID), goal.status, clip(goal.objective, 60), clock(goal.updatedAt)].join("  "),
  )
  return block(format(messages["debug.sessions.header"], { pluginId, n: all.length }), rows, messages)
}

async function renderState(
  deps: GoalDeps,
  pluginId: string,
  sessionID: string,
  snapshot: DebugSnapshot,
): Promise<string> {
  const messages = deps.messages
  const state = snapshot.sessions.find((item) => item.sessionID === sessionID)
  const goal = await deps.repo.load(sessionID)
  const cache = state?.sessionDirectory
  return block(
    format(messages["debug.state.header"], { pluginId }),
    [
      format(messages["debug.state.session"], { id: sessionID }),
      format(messages["debug.state.turnOpen"], {
        value: state === undefined ? messages["debug.noTrackedState"] : String(state.turnOpen),
      }),
      format(messages["debug.state.agent"], { agent: state?.agent ?? messages["debug.unknown"] }),
      format(messages["debug.state.directoryCache"], {
        dir: cache === undefined || cache === null ? messages["debug.none"] : cache,
      }),
      format(messages["debug.state.pendingAutomatic"], {
        value: state === undefined ? "-" : String(state.pendingAutomatic),
      }),
      format(messages["debug.state.pendingBackground"], { value: state === undefined ? "-" : state.pendingBackground }),
      format(messages["debug.state.blockedThisTurn"], {
        value: state === undefined ? "-" : String(state.blockedThisTurn),
      }),
      format(messages["debug.state.goal"], {
        goal:
          goal === undefined
            ? messages["debug.none"]
            : `${goal.status}, continuations=${goal.continuations ?? 0}, emptyStreak=${goal.emptyStreak}, blockerStreak=${goal.blockerStreak}`,
      }),
    ],
    messages,
  )
}

/**
 * `/goal-debug` 的确定性入口：只读、不唤醒模型；**但仍会落一条消息进历史**（故输出必须短）。
 * 输出保持**短**且为纯文本：命令的唯一出口是往会话插一条消息，会留在历史里。
 */
export function createDebug(deps: GoalDeps, source: DebugSource): Debug {
  return {
    async render(rawOp, sessionID) {
      const messages = deps.messages
      const op = rawOp.trim().toLowerCase()
      switch (op) {
        case "":
        case "help":
          return usage(messages, source.pluginId)
        case "env":
          return renderEnv(deps, source, sessionID)
        case "events":
          return renderEvents(source.pluginId, messages, source.snapshot().events)
        case "sessions":
          return renderSessions(deps, source.pluginId)
        case "state":
          return renderState(deps, source.pluginId, sessionID, source.snapshot())
        default:
          return format(messages["debug.unknownSubcommand"], { op, usage: usage(messages, source.pluginId) })
      }
    },
  }
}
