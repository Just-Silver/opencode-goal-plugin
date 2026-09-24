import { pause as pauseGoal, resume as resumeGoal } from "../model/goal"
import type { Goal } from "../model/types"
import { newWorkOf, usageIsComplete, withPending } from "../model/usage"
import { goalCommandPrompt } from "../prompts/index"
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
}

/** 命令面的确定性入口：全部零 token、零歧义；只有 `/goal <目标>` 会转发给模型。 */
export function createCommandHandlers(deps: GoalDeps, port: CommandPort): GoalCommandHandlers {
  const status = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    await port.notify(
      sessionID,
      existing ? statusLine(withPending(existing, deps.pendingUsage?.(sessionID))) : "No goal is set for this session.",
    )
  }

  const pause = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, "No goal is set for this session.")
    if (existing.status !== "active") return port.notify(sessionID, `Goal is ${existing.status}; nothing to pause.`)
    await deps.repo.save(sessionID, pauseGoal(existing, deps.now()))
    return port.notify(sessionID, "Goal paused.")
  }

  const resume = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, "No goal is set for this session.")
    let resumed: Goal
    try {
      resumed = resumeGoal(existing, deps.now())
    } catch {
      return port.notify(sessionID, `Goal is ${existing.status}; nothing to resume.`)
    }
    await deps.repo.save(sessionID, resumed)
    return port.notify(sessionID, "Goal resumed.")
  }

  const clear = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, "No goal is set for this session.")
    await deps.repo.remove(sessionID)
    return port.notify(sessionID, "Goal cleared.")
  }

  return {
    goal: async (input) => {
      const parsed = parseGoalCommand(input.prompt.text)
      if (parsed.kind === "status") return status(input.sessionID)
      await port.deliver({
        sessionID: input.sessionID,
        text: goalCommandPrompt(parsed.objective ?? ""),
        description: noticeLine("Goal request", parsed.objective ?? ""),
      })
    },
    status,
    pause,
    resume,
    clear,
  }
}

function statusLine(goal: Goal): string {
  const budget = goal.tokenBudget === undefined ? "no budget" : `budget ${goal.tokenBudget}`
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : undefined
  const detail = usage ? ` (cacheRead ${usage.cacheRead} · new work ${newWorkOf(usage)})` : ""
  return `Goal (${goal.status}) — tokens ${goal.tokensUsed} / ${budget}${detail}; ${goal.timeUsedSeconds}s. Objective: ${goal.objective}`
}