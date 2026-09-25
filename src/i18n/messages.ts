import type { GoalStatus } from "../model/types"

/** 全部面向用户（TUI）文案 + 工具 schema 文案的键。两语言目录都必须满足本接口。 */
export interface Messages {
  readonly "cmd.goal": string
  readonly "cmd.status": string
  readonly "cmd.pause": string
  readonly "cmd.resume": string
  readonly "cmd.clear": string
  readonly "cmd.debug": string
  readonly "notice.noGoal": string
  readonly "notice.paused": string
  readonly "notice.resumed": string
  readonly "notice.cleared": string
  readonly "notice.nothingToPause": string
  readonly "notice.nothingToResume": string
  readonly "label.goalRequest": string
  readonly "label.autoContinue": string
  readonly "status.active": string
  readonly "status.paused": string
  readonly "status.blocked": string
  readonly "status.budget-limited": string
  readonly "status.usage-limited": string
  readonly "status.complete": string
  readonly "status.line": string
  readonly "status.budget": string
  readonly "status.noBudget": string
  readonly "status.detail": string
  readonly "status.lastError": string
  readonly "signal.usage-limited": string
  readonly "signal.budget-limited": string
  readonly "signal.detail": string
  readonly "signal.blocked": string
  readonly "debug.usage": string
  readonly "debug.env.header": string
  readonly "debug.env.instanceLocation": string
  readonly "debug.env.session": string
  readonly "debug.env.sessionDirectory": string
  readonly "debug.env.belongs": string
  readonly "debug.env.options": string
  readonly "debug.events.header": string
  readonly "debug.sessions.header": string
  readonly "debug.state.header": string
  readonly "debug.state.session": string
  readonly "debug.state.turnOpen": string
  readonly "debug.state.agent": string
  readonly "debug.state.directoryCache": string
  readonly "debug.state.pendingAutomatic": string
  readonly "debug.state.pendingBackground": string
  readonly "debug.state.blockedThisTurn": string
  readonly "debug.state.goal": string
  readonly "debug.unknownSubcommand": string
  readonly "debug.none": string
  readonly "debug.unknownValue": string
  readonly "debug.unknown": string
  readonly "debug.noTrackedState": string
  readonly "debug.yes": string
  readonly "debug.no": string
  readonly "tool.goal.description": string
  readonly "tool.goal.op": string
  readonly "tool.goal.objective": string
  readonly "tool.goal.tokenBudget": string
  readonly "tool.goal.blockerKey": string
  readonly "tool.goal.blocker": string
  readonly "tool.debug.description": string
  readonly "tool.debug.op": string
}

export type MessageKey = keyof Messages

/** 把 {name} 占位符替换为 params[name]；未提供的占位符原样保留（不抛）。 */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** 用户可见的状态词（active → 进行中 / active）。 */
export function statusLabel(messages: Messages, status: GoalStatus): string {
  switch (status) {
    case "active":
      return messages["status.active"]
    case "paused":
      return messages["status.paused"]
    case "blocked":
      return messages["status.blocked"]
    case "budget-limited":
      return messages["status.budget-limited"]
    case "usage-limited":
      return messages["status.usage-limited"]
    case "complete":
      return messages["status.complete"]
  }
}
