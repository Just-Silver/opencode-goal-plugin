import { GoalError, pause as pauseGoal, rebuild as rebuildGoal, resume as resumeGoal } from "../model/goal"
import { setBudget } from "../model/limits"
import { normalizeObjective } from "../model/objective"
import type { Goal, StopReason } from "../model/types"
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
  /** 把回执显示给用户（status/pause/resume/clear）；实现为发 RPC 事件 → TUI toast（不写会话消息、0 token）。 */
  readonly notify: (sessionID: string, text: string) => Promise<void>
  /** 目标停摆回执（预算命中）：走会话合成消息 —— `description` 给人看（落转录、不会消失）、`text` 要求模型收尾并唤醒一轮，人和模型都看得到。 */
  readonly announce: (sessionID: string, input: { reason: StopReason; message: string }) => Promise<void>
  /**
   * 恢复/解锁后的「激活」：**只在会话空闲时**投递一轮续跑（复用续跑通道：计数、受限 agent 判定、一行触发语）。
   * 会话在跑时投递会被宿主当成 steer 插进当前轮，所以必须避开。
   * 返回 `delivered`（已投递）/ `busy`（会话正在跑，会在轮末自然续跑）/ `skipped`（无可用 agent 或受限 agent）。
   */
  readonly activate: (sessionID: string) => Promise<"delivered" | "busy" | "skipped">
}

export interface CommandInput {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
}

export interface GoalCommandHandlers {
  /** `/goal <目标>`：空参报告状态，其余转发给模型。 */
  readonly goal: (input: CommandInput) => Promise<void>
  /** `<name>-status`：服务端确定性报告（不唤醒模型；回执走 TUI toast，不写会话消息）。 */
  readonly status: (sessionID: string) => Promise<void>
  readonly pause: (sessionID: string) => Promise<void>
  readonly resume: (sessionID: string) => Promise<void>
  readonly clear: (sessionID: string) => Promise<void>
  /** `${name}-budget`：不唤醒模型地改/清空当前目标的预算（回执走 TUI toast）。 */
  readonly budget: (sessionID: string, text: string) => Promise<void>
  /** `${name}-rebuild`：不唤醒模型地替换当前目标的正文（状态、预算与全部记账原样保留；回执走 TUI toast）。 */
  readonly rebuild: (sessionID: string, text: string) => Promise<void>
}

/** 命令面的确定性入口：全部不唤醒模型、零歧义；只有 `/goal <目标>` 会转发给模型。
 * 回执经 RPC 事件推给 TUI toast（不写会话消息、0 token）；无 TUI 时静默。 */
export function createCommandHandlers(deps: GoalDeps, port: CommandPort): GoalCommandHandlers {
  /** 激活结果 → 一句给用户的补充：让他知道目标到底有没有真的跑起来（「已恢复」不等于「在跑」）。 */
  const activationNote = (activation: "delivered" | "busy" | "skipped"): string =>
    activation === "delivered"
      ? deps.messages["notice.activated"]
      : activation === "busy"
        ? deps.messages["notice.activatedBusy"]
        : deps.messages["notice.activatedSkipped"]

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
    // 预算不够就不恢复：恢复了下一轮末也会被 `applyBudget` 打回 budget-limited（白跑一轮），
    // 只会让用户以为「恢复成功了」。直接告诉用户该怎么继续。
    if (resumed.tokenBudget !== undefined && resumed.tokensUsed >= resumed.tokenBudget)
      return port.notify(
        sessionID,
        format(deps.messages["notice.resumeBudgetLow"], {
          used: resumed.tokensUsed,
          budget: resumed.tokenBudget,
        }),
      )
    await deps.repo.save(sessionID, resumed)
    // 激活：只在会话空闲时投递一轮续跑（在跑的话本轮末自然会续，不用插队）。
    // 回执必须说清「到底有没有真的跑起来」——「已恢复」不等于「在跑」。
    const activation = await port.activate(sessionID)
    return port.notify(sessionID, `${deps.messages["notice.resumed"]} ${activationNote(activation)}`)
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
    // 新预算低于已用量 → 目标当场进入 budget-limited。补一条**停摆回执**：合成消息 + 唤醒一轮收尾，
    // 否则只有一条会自动消失的命令回执 toast，人和模型都不知道目标已经停了。
    if (existing.status !== "budget-limited" && goal.status === "budget-limited")
      await port.announce(sessionID, { reason: "budget-limited", message: "" })
    // 预算改大后目标会自动回 active（`model/limits.ts` 的 `setBudget`）——此时也要激活一次，
    // 否则会出现「状态是 active 却没人跑」，而 `/goal-resume` 又会因「无需恢复」拒绝，形成死路。
    const activation =
      existing.status !== "active" && goal.status === "active" ? await port.activate(sessionID) : undefined
    const status = statusLabel(deps.messages, goal.status)
    const receipt =
      desired === undefined
        ? format(deps.messages["notice.budgetCleared"], { status })
        : format(deps.messages["notice.budgetSet"], { budget: desired, status })
    // 激活结果一并告诉用户（「目标已 active」不等于「已经在跑」）。
    return port.notify(sessionID, activation === undefined ? receipt : `${receipt} ${activationNote(activation)}`)
  }

  const rebuild = async (sessionID: string, text: string): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return port.notify(sessionID, deps.messages["notice.rebuildUsage"])
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    if (existing.status === "complete")
      return port.notify(
        sessionID,
        format(deps.messages["notice.nothingToRebuild"], { status: statusLabel(deps.messages, existing.status) }),
      )
    const check = normalizeObjective(trimmed, deps.options.maxObjectiveChars)
    if (!check.ok) return port.notify(sessionID, deps.messages["notice.rebuildUsage"])
    await deps.repo.save(sessionID, rebuildGoal(existing, check.objective, deps.now()))
    return port.notify(
      sessionID,
      format(deps.messages["notice.rebuilt"], { status: statusLabel(deps.messages, existing.status) }),
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
    rebuild,
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
  const created = format(messages["status.created"], { time: localTime(goal.createdAt) })
  return format(messages["status.line"], {
    status: statusLabel(messages, goal.status),
    tokens: goal.tokensUsed,
    budget,
    detail,
    created,
    seconds: goal.timeUsedSeconds,
    lastError,
    continuations,
    objective: goal.objective,
  })
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** 本地墙钟时间 `YYYY-MM-DD HH:mm`（给人看，用本地时区而非 UTC）。 */
function localTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}