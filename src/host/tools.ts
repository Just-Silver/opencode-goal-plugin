import type { Messages } from "../i18n/messages"
import { applyBlocker } from "../model/blocked"
import { complete, rebuild } from "../model/goal"
import { applyBudget } from "../model/limits"
import { normalizeObjective } from "../model/objective"
import { parseToolArgs } from "../model/tool-args"
import { buildToolResult } from "../model/tool-result"
import type { Goal } from "../model/types"
import { withPending } from "../model/usage"
import { blockedWrapUp, budgetLimitPrompt, rewriteStoppedNote } from "../prompts/index"
import type { GoalDeps } from "./deps"

export const GOAL_TOOL_NAME = "goal"

/** 宿主按 JSON Schema 解析；用 any 避免与 effect 的 JsonSchema 类型耦合。 */
export function goalToolInput(messages: Messages): any {
  return {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["get", "complete", "rewrite", "block"],
        description: messages["tool.goal.op"],
      },
      objective: { type: "string", description: messages["tool.goal.objective"] },
      blocker_key: { type: "string", description: messages["tool.goal.blockerKey"] },
      blocker: { type: "string", description: messages["tool.goal.blocker"] },
    },
    required: ["op"],
    additionalProperties: false,
  }
}

export interface GoalToolContext {
  readonly sessionID: string
  readonly agent: string
}

export interface GoalToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: any
  readonly execute: (input: any, context: GoalToolContext) => Promise<{ content: string }>
}

function asContent(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) }
}

export function createGoalTool(deps: GoalDeps): GoalToolDefinition {
  return {
    name: GOAL_TOOL_NAME,
    description: deps.messages["tool.goal.description"],
    input: goalToolInput(deps.messages),
    async execute(raw, context) {
      const parsed = parseToolArgs(raw)
      if (!parsed.ok) throw new Error(parsed.message)
      const args = parsed.args
      const { sessionID } = context
      const now = deps.now()
      const existing = await deps.repo.load(sessionID)
      // 展示用：叠加本轮尚未落账的用量（持久化只到上一轮为止；轮末才 flush）。
      const view = (goal: Goal) => buildToolResult(withPending(goal, deps.pendingUsage?.(sessionID)))

      switch (args.op) {
        case "get": {
          return asContent(existing ? view(existing) : { goal: null })
        }

        case "complete": {
          if (!existing) throw new Error("goal: no goal to complete")
          if (existing.status !== "active") throw new Error(`goal: cannot complete a ${existing.status} goal`)
          const goal = complete(existing, now)
          await deps.repo.save(sessionID, goal)
          return asContent(view(goal))
        }

        case "rewrite": {
          if (deps.isRestricted(context.agent)) throw new Error("goal: this agent cannot rewrite the objective")
          if (!existing) throw new Error("goal: no goal to rewrite")
          if (existing.status === "complete") throw new Error("goal: cannot rewrite a completed goal")
          const check = normalizeObjective(args.objective ?? "", deps.options.maxObjectiveChars)
          if (!check.ok) throw new Error('goal: rewrite requires a non-empty "objective"')
          const goal = rebuild(existing, check.objective, now)
          await deps.repo.save(sessionID, goal)
          const result = view(goal)
          // 改写只换正文、不恢复执行：非 active 时明确告诉模型目标不会自动续跑，别以为「改完就跑了」。
          if (goal.status !== "active") return asContent({ ...result, instruction: rewriteStoppedNote(goal.status) })
          return asContent(result)
        }

        case "block": {
          if (!existing) throw new Error("goal: no goal to block")
          // 只有 active 才计数；非 active 时静默成功会让模型误以为「阻碍已上报」。与 complete 一样明确拒绝。
          if (existing.status !== "active")
            throw new Error(`goal: cannot report a blocker for a ${existing.status} goal`)
          const { goal: reported, blocked } = applyBlocker(
            existing,
            { key: args.blockerKey ?? "unknown", text: args.blocker ?? "" },
            deps.options.blockedThreshold,
            now,
          )
          const goal = applyBudget(reported, now)
          await deps.repo.save(sessionID, goal)
          const result = view(goal)
          if (goal.status === "blocked" && blocked)
            return asContent({ ...result, instruction: blockedWrapUp(goal) })
          if (goal.status === "budget-limited")
            return asContent({
              ...result,
              instruction: budgetLimitPrompt(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }),
            })
          return asContent(result)
        }
      }
    },
  }
}
