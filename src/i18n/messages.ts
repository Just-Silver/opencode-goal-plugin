import type { GoalStatus } from "../model/types"

/** 全部面向用户（TUI）文案 + 工具 schema 文案的键。两语言目录都必须满足本接口。 */
export interface Messages {
  readonly "cmd.goal": string
  readonly "cmd.status": string
  readonly "cmd.pause": string
  readonly "cmd.resume": string
  readonly "cmd.clear": string
  readonly "cmd.debug": string
  readonly "cmd.budget": string
  readonly "cmd.rebuild": string
  readonly "notice.title": string
  readonly "notice.truncated": string
  readonly "notice.noGoal": string
  readonly "notice.paused": string
  readonly "notice.resumed": string
  readonly "notice.cleared": string
  readonly "notice.nothingToPause": string
  readonly "notice.nothingToResume": string
  readonly "notice.resumeBudgetLow": string
  readonly "notice.activated": string
  readonly "notice.activatedBusy": string
  readonly "notice.activatedSkipped": string
  readonly "notice.budgetSet": string
  readonly "notice.budgetCleared": string
  readonly "notice.budgetUsage": string
  readonly "notice.budgetInvalid": string
  readonly "notice.budgetExceedsMax": string
  readonly "notice.rebuildUsage": string
  readonly "notice.rebuilt": string
  readonly "notice.nothingToRebuild": string
  readonly "label.goalRequest": string
  readonly "label.autoContinue": string
  readonly "status.active": string
  readonly "status.paused": string
  readonly "status.blocked": string
  readonly "status.budget-limited": string
  readonly "status.usage-limited": string
  readonly "status.complete": string
  readonly "status.line": string
  readonly "status.created": string
  readonly "status.budget": string
  readonly "status.noBudget": string
  readonly "status.continuations": string
  readonly "status.detail": string
  readonly "status.lastError": string
  readonly "duration.day": string
  readonly "duration.hour": string
  readonly "duration.minute": string
  readonly "duration.second": string
  readonly "duration.join": string
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

type DurationUnit = "duration.day" | "duration.hour" | "duration.minute" | "duration.second"

/**
 * 展示用的人类可读时长：最多两级单位（`45s` / `12m 30s` / `5h 30m` / `2d 3h`），
 * 低位为 0 时省略；单位与连接符由目录本地化（英文带空格、中文不带）。
 * **纯展示**——模型侧（工具返回、预算提示词）仍用原始整数秒，见 AGENTS。
 */
export function formatDuration(messages: Messages, seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const unit = (value: number, suffix: DurationUnit): string => `${value}${messages[suffix]}`
  const join = (first: string, second?: string): string =>
    second === undefined ? first : format(messages["duration.join"], { first, second })
  if (total < 60) return unit(total, "duration.second")
  if (total < 3600) {
    const rest = total % 60
    return join(unit(Math.floor(total / 60), "duration.minute"), rest > 0 ? unit(rest, "duration.second") : undefined)
  }
  if (total < 86400) {
    const rest = Math.floor((total % 3600) / 60)
    return join(unit(Math.floor(total / 3600), "duration.hour"), rest > 0 ? unit(rest, "duration.minute") : undefined)
  }
  const rest = Math.floor((total % 86400) / 3600)
  return join(unit(Math.floor(total / 86400), "duration.day"), rest > 0 ? unit(rest, "duration.hour") : undefined)
}
