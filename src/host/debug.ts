import type { GoalDeps } from "./deps"
import type { DebugEventRecord, DebugSnapshot } from "./events"

/** 调试专用的只读视图（由 events 路由提供）。 */
export interface DebugSource {
  readonly pluginId: string
  readonly snapshot: () => DebugSnapshot
}

export interface Debug {
  /** 渲染一次诊断输出（纯文本/Markdown）；空 op 或未知 op 返回帮助。 */
  render(op: string, sessionID: string): Promise<string>
}

export const DEBUG_OPS = ["env", "events", "sessions", "state"] as const

function short(id: string, length = 16): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23)
}

function help(pluginId: string): string {
  return [
    `### ${pluginId} debug`,
    "",
    "- `env` — 本实例的 location、目标会话所在目录、归属判定",
    "- `events` — 最近事件 + 归属判定结果（allow / drop-other-location / drop-unknown-session）",
    "- `sessions` — 已存储的全部 goal 记录",
    "- `state` — 本会话的内存轮状态",
  ].join("\n")
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${header.join(" | ")} |`
  const sep = `| ${header.map(() => "---").join(" | ")} |`
  if (rows.length === 0) return `${head}\n${sep}\n| ${header.map(() => "").join(" | ")} |`
  return [head, sep, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")
}

async function renderEnv(deps: GoalDeps, source: DebugSource, sessionID: string): Promise<string> {
  const directory = await deps.sessionDirectory(sessionID)
  const verdict = directory === undefined ? "unknown" : directory === deps.locationDirectory ? "yes" : "no"
  return [
    `### ${source.pluginId} debug env`,
    "",
    `- instance location: \`${deps.locationDirectory}\``,
    `- session: \`${sessionID}\``,
    `- session directory: ${directory === undefined ? "(unknown)" : `\`${directory}\``}`,
    `- belongs to this instance: **${verdict}**`,
    `- options: \`${JSON.stringify(deps.options)}\``,
  ].join("\n")
}

function renderEvents(pluginId: string, events: readonly DebugEventRecord[]): string {
  const rows = events.map((event) => [
    clock(event.at),
    event.type,
    event.sessionID === undefined ? "-" : short(event.sessionID),
    event.hasLocation ? short(event.location ?? "", 28) : "-",
    event.decision,
  ])
  return [`### ${pluginId} debug events (last ${events.length})`, "", table(["at", "type", "session", "location", "decision"], rows)].join(
    "\n",
  )
}

async function renderSessions(deps: GoalDeps, pluginId: string): Promise<string> {
  const all = await deps.repo.listAll()
  const rows = all.map(({ sessionID, goal }) => [
    short(sessionID),
    goal.status,
    goal.objective.length > 60 ? `${goal.objective.slice(0, 60)}…` : goal.objective,
    clock(goal.updatedAt),
  ])
  return [`### ${pluginId} debug sessions (${all.length})`, "", table(["session", "status", "objective", "updated"], rows)].join("\n")
}

async function renderState(deps: GoalDeps, pluginId: string, sessionID: string, snapshot: DebugSnapshot): Promise<string> {
  const state = snapshot.sessions.find((item) => item.sessionID === sessionID)
  const goal = await deps.repo.load(sessionID)
  return [
    `### ${pluginId} debug state`,
    "",
    `- session: \`${sessionID}\``,
    `- turn open: ${state === undefined ? "(no tracked state)" : state.turnOpen}`,
    `- agent: ${state?.agent ?? "unknown"}`,
    `- session directory cache: ${state?.sessionDirectory === undefined || state?.sessionDirectory === null ? "(none)" : `\`${state.sessionDirectory}\``}`,
    `- pending automatic: ${state === undefined ? "-" : state.pendingAutomatic}`,
    `- blocked this turn: ${state === undefined ? "-" : state.blockedThisTurn}`,
    `- goal: ${goal === undefined ? "(none)" : `${goal.status}, emptyStreak=${goal.emptyStreak}, blockerStreak=${goal.blockerStreak}`}`,
  ].join("\n")
}

/**
 * `/goal-debug` 的确定性入口：零 token、只读、不产生任何副作用。
 * 故意与业务工具分开，避免调试标记污染 `goal` 的正常输出。
 */
export function createDebug(deps: GoalDeps, source: DebugSource): Debug {
  return {
    async render(rawOp, sessionID) {
      const op = rawOp.trim().toLowerCase()
      switch (op) {
        case "":
        case "help":
          return help(source.pluginId)
        case "env":
          return renderEnv(deps, source, sessionID)
        case "events":
          return renderEvents(source.pluginId, source.snapshot().events)
        case "sessions":
          return renderSessions(deps, source.pluginId)
        case "state":
          return renderState(deps, source.pluginId, sessionID, source.snapshot())
        default:
          return `Unknown debug subcommand: \`${op}\`\n\n${help(source.pluginId)}`
      }
    },
  }
}
