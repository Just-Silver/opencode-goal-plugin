import { GoalError, pause as pauseGoal, resume as resumeGoal } from "../model/goal"
import { setBudget } from "../model/limits"
import type { Goal } from "../model/types"
import { newWorkOf, usageIsComplete, withPending } from "../model/usage"
import { goalCommandPrompt } from "../prompts/index"
import { format, statusLabel, type Messages } from "../i18n/messages"
import type { GoalDeps } from "./deps"
import { noticeLine } from "./notice"

export type GoalCommandKind = "status" | "objective"

export interface ParsedGoalCommand {
  readonly kind: GoalCommandKind
  readonly objective?: string
}

/**
 * `/goal` 的参数解析：空参 → 报告状态；其余**一律**作为目标原文。
 * 没有保留名/子命令 —— 宿主侧也没有子命令概念（只有 name + 参数文本），
 * 后台拦截会让用户打错一个字就变成"目标文字"，所以状态控制改为独立命令
 * （`<name>-status` / `-pause` / `-resume` / `-clear`）。
 */
export function parseGoalCommand(text: string): ParsedGoalCommand {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "status" }
  return { kind: "objective", objective: trimmed }
}

export type BudgetArg =
  | { readonly kind: "usage" }
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly budget: number }
  | { readonly kind: "invalid"; readonly value: string }

/** `/goal-budget` 参数：空 → 用法；none/off/0 → 清空；其余必须为正整数。 */
export function parseBudgetArg(text: string): BudgetArg {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "usage" }
  if (/^(none|off|0)$/i.test(trimmed)) return { kind: "clear" }
  if (/^[1-9]\d*$/.test(trimmed)) {
    const value = Number(trimmed)
    return Number.isSafeInteger(value) ? { kind: "set", budget: value } : { kind: "invalid", value: trimmed }
  }
  return { kind: "invalid", value: trimmed }
}

export interface CommandPort {
  /** 触发一次模型轮（转发目标文本）。走 synthetic，TUI 只显示 `description` 一行。 */
  readonly deliver: (input: { sessionID: string; text: string; description: string }) => Promise<void>
  /** 不经模型地把消息显示给用户（status/pause/resume/clear 的回执）。 */
  readonly notify: (sessionID: string, text: string) => Promise<void>
}

export interface CommandInput {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
}

export interface GoalCommandHandlers {
  /** `/goal <目标>`：空参报告状态，其余转发给模型。 */
  readonly goal: (input: CommandInput) => Promise<void>
  /** `<name>-status`：服务端确定性报告（零 token）。 */
  readonly status: (sessionID: string) => Promise<void>
  readonly pause: (sessionID: string) => Promise<void>
  readonly resume: (sessionID: string) => Promise<void>
  readonly clear: (sessionID: string) => Promise<void>
  /** `${name}-budget`：零 token 地改/清空当前目标的预算。 */
  readonly budget: (sessionID: string, text: string) => Promise<void>
}

/** 命令面的确定性入口：全部零 token、零歧义；只有 `/goal <目标>` 会转发给模型。 */
export function createCommandHandlers(deps: GoalDeps, port: CommandPort): GoalCommandHandlers {
  const status = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    await port.notify(
      sessionID,
      existing
        ? statusLine(withPending(existing, deps.pendingUsage?.(sessionID)), deps.messages)
        : deps.messages["notice.noGoal"],
    )
  }

  const pause = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    if (existing.status !== "active")
      return port.notify(
        sessionID,
        format(deps.messages["notice.nothingToPause"], { status: statusLabel(deps.messages, existing.status) }),
      )
    await deps.repo.save(sessionID, pauseGoal(existing, deps.now()))
    return port.notify(sessionID, deps.messages["notice.paused"])
  }

  const resume = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    let resumed: Goal
    try {
      resumed = resumeGoal(existing, deps.now())
    } catch {
      return port.notify(
        sessionID,
        format(deps.messages["notice.nothingToResume"], { status: statusLabel(deps.messages, existing.status) }),
      )
    }
    await deps.repo.save(sessionID, resumed)
    return port.notify(sessionID, deps.messages["notice.resumed"])
  }

  const clear = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    await deps.repo.remove(sessionID)
    return port.notify(sessionID, deps.messages["notice.cleared"])
  }

  const budget = async (sessionID: string, text: string): Promise<void> => {
    const parsed = parseBudgetArg(text)
    if (parsed.kind === "usage") return port.notify(sessionID, deps.messages["notice.budgetUsage"])
    if (parsed.kind === "invalid")
      return port.notify(sessionID, format(deps.messages["notice.budgetInvalid"], { value: parsed.value }))
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    const desired = parsed.kind === "clear" ? undefined : parsed.budget
    let goal: Goal
    try {
      goal = setBudget(existing, { budget: desired, maxTokenBudget: deps.options.maxGoalTokenBudget, now: deps.now() })
    } catch (error) {
      if (error instanceof GoalError && error.code === "budget-exceeds-max")
        return port.notify(
          sessionID,
          format(deps.messages["notice.budgetExceedsMax"], {
            budget: desired ?? 0,
            max: deps.options.maxGoalTokenBudget ?? 0,
          }),
        )
      if (error instanceof GoalError)
        return port.notify(sessionID, format(deps.messages["notice.budgetInvalid"], { value: text.trim() }))
      throw error
    }
    await deps.repo.save(sessionID, goal)
    const status = statusLabel(deps.messages, goal.status)
    return port.notify(
      sessionID,
      desired === undefined
        ? format(deps.messages["notice.budgetCleared"], { status })
        : format(deps.messages["notice.budgetSet"], { budget: desired, status }),
    )
  }

  return {
    goal: async (input) => {
      const parsed = parseGoalCommand(input.prompt.text)
      if (parsed.kind === "status") return status(input.sessionID)
      await port.deliver({
        sessionID: input.sessionID,
        text: goalCommandPrompt(parsed.objective ?? ""),
        description: noticeLine(deps.messages["label.goalRequest"], parsed.objective ?? "", Number.POSITIVE_INFINITY),
      })
    },
    status,
    pause,
    resume,
    clear,
    budget,
  }
}

function statusLine(goal: Goal, messages: Messages): string {
  const budget =
    goal.tokenBudget === undefined
      ? messages["status.noBudget"]
      : format(messages["status.budget"], { budget: goal.tokenBudget })
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : undefined
  const detail = usage
    ? format(messages["status.detail"], { cacheRead: usage.cacheRead, newWork: newWorkOf(usage) })
    : ""
  const continuations = format(messages["status.continuations"], { count: goal.continuations ?? 0 })
  const lastError = goal.lastError
    ? format(messages["status.lastError"], { error: goal.lastError.message || goal.lastError.type })
    : ""
  return format(messages["status.line"], {
    status: statusLabel(messages, goal.status),
    tokens: goal.tokensUsed,
    budget,
    detail,
    seconds: goal.timeUsedSeconds,
    lastError,
    continuations,
    objective: goal.objective,
  })
}