import { pause, resume } from "../model/goal"
import type { Goal } from "../model/types"
import { goalCommandPrompt } from "../prompts/index"
import type { GoalDeps } from "./deps"

export type GoalCommandKind = "pause" | "resume" | "clear" | "status" | "objective"

export interface ParsedGoalCommand {
  readonly kind: GoalCommandKind
  readonly objective?: string
}

const START_VERBS = new Set(["start", "begin"])

/** `/goal` 的参数解析。仅保留名走服务端确定性分支，其余内容原样交给模型。 */
export function parseGoalCommand(text: string): ParsedGoalCommand {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "status" }
  const [head = "", ...rest] = trimmed.split(/\s+/)
  const verb = head.toLowerCase()
  if (verb === "pause") return { kind: "pause" }
  if (verb === "resume") return { kind: "resume" }
  if (verb === "clear") return { kind: "clear" }
  if (verb === "status" || verb === "show") return { kind: "status" }
  if (START_VERBS.has(verb) && rest.length > 0) return { kind: "objective", objective: rest.join(" ") }
  return { kind: "objective", objective: trimmed }
}

export interface CommandPort {
  /** 触发一次模型轮（用于转发目标文本）。 */
  readonly prompt: (sessionID: string, text: string) => Promise<void>
  /** 不经模型地把消息显示给用户（pause/resume/clear/status 的回执）。 */
  readonly notify: (sessionID: string, text: string) => Promise<void>
}

export interface CommandInput {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
}

/** `/goal` 的确定性入口：保留名走服务端分支（零 token、零歧义），其余交给模型。 */
export function createCommandHandler(deps: GoalDeps, port: CommandPort): (input: CommandInput) => Promise<void> {
  return async (input) => {
    const { sessionID } = input
    const parsed = parseGoalCommand(input.prompt.text)
    const now = deps.now()
    const existing = await deps.repo.load(sessionID)

    switch (parsed.kind) {
      case "objective":
        await port.prompt(sessionID, goalCommandPrompt(parsed.objective ?? ""))
        return
      case "status":
        await port.notify(sessionID, existing ? statusLine(existing) : "No goal is set for this session.")
        return
      case "pause": {
        if (!existing) return port.notify(sessionID, "No goal is set for this session.")
        if (existing.status !== "active") return port.notify(sessionID, `Goal is ${existing.status}; nothing to pause.`)
        await deps.repo.save(sessionID, pause(existing, now))
        return port.notify(sessionID, "Goal paused.")
      }
      case "resume": {
        if (!existing) return port.notify(sessionID, "No goal is set for this session.")
        let resumed: Goal
        try {
          resumed = resume(existing, now)
        } catch {
          return port.notify(sessionID, `Goal is ${existing.status}; nothing to resume.`)
        }
        await deps.repo.save(sessionID, resumed)
        return port.notify(sessionID, "Goal resumed.")
      }
      case "clear": {
        if (!existing) return port.notify(sessionID, "No goal is set for this session.")
        await deps.repo.remove(sessionID)
        return port.notify(sessionID, "Goal cleared.")
      }
    }
  }
}

function statusLine(goal: Goal): string {
  const budget = goal.tokenBudget === undefined ? "no token budget" : `${goal.tokensUsed}/${goal.tokenBudget} tokens`
  return `Goal (${goal.status}) — ${budget}; ${goal.timeUsedSeconds}s. Objective: ${goal.objective}`
}
