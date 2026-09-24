import { applyBlocker } from "../model/blocked"
import { complete, createGoal, resume } from "../model/goal"
import { applyBudget } from "../model/limits"
import { normalizeObjective } from "../model/objective"
import { parseToolArgs } from "../model/tool-args"
import { buildToolResult } from "../model/tool-result"
import { isOpenStatus } from "../model/types"
import { blockedWrapUp, budgetLimitPrompt } from "../prompts/index"
import type { GoalDeps } from "./deps"

export const GOAL_TOOL_NAME = "goal"

/** 宿主按 JSON Schema 解析；用 any 避免与 effect 的 JsonSchema 类型耦合。 */
export const goalToolInput: any = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["create", "get", "complete", "resume", "drop", "block"] },
    objective: { type: "string" },
    token_budget: { type: "integer", minimum: 1 },
    blocker_key: { type: "string" },
    blocker: { type: "string" },
  },
  required: ["op"],
  additionalProperties: false,
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
    description:
      'Manage the persistent goal for this session. op "create" starts a goal only when explicitly requested; "get" reports it; "complete" asserts evidence-backed completion; "resume"/"drop" are also available; "block" reports a recurring blocker.',
    input: goalToolInput,
    async execute(raw, context) {
      const parsed = parseToolArgs(raw)
      if (!parsed.ok) throw new Error(parsed.message)
      const args = parsed.args
      const { sessionID } = context
      const now = deps.now()
      const existing = await deps.repo.load(sessionID)

      switch (args.op) {
        case "create": {
          if (deps.isRestricted(context.agent)) throw new Error("goal: this agent cannot create a goal")
          if (existing && isOpenStatus(existing.status))
            throw new Error(`goal: a goal is already open (${existing.status}); complete or drop it first`)
          const check = normalizeObjective(args.objective ?? "", deps.options.maxObjectiveChars)
          if (!check.ok) throw new Error("goal: objective must be a non-empty string")
          const goal = createGoal({
            goalId: deps.newGoalId(),
            objective: check.objective,
            now,
            tokenBudget: args.tokenBudget ?? deps.options.tokenBudget,
            maxTokenBudget: deps.options.maxGoalTokenBudget,
          })
          await deps.repo.save(sessionID, goal)
          return asContent(buildToolResult(goal))
        }

        case "get": {
          return asContent(existing ? buildToolResult(existing) : { goal: null })
        }

        case "complete": {
          if (!existing) throw new Error("goal: no goal to complete")
          if (existing.status !== "active") throw new Error(`goal: cannot complete a ${existing.status} goal`)
          const goal = complete(existing, now)
          await deps.repo.save(sessionID, goal)
          return asContent(buildToolResult(goal))
        }

        case "resume": {
          if (!existing) throw new Error("goal: no goal to resume")
          if (deps.isRestricted(context.agent)) throw new Error("goal: this agent cannot resume a goal")
          const resumed = resume(existing, now)
          const goal = applyBudget(resumed, now)
          await deps.repo.save(sessionID, goal)
          return asContent(buildToolResult(goal))
        }

        case "drop": {
          if (!existing) throw new Error("goal: no goal to drop")
          await deps.repo.remove(sessionID)
          return asContent({ goal: null, dropped: true })
        }

        case "block": {
          if (!existing) throw new Error("goal: no goal to block")
          const { goal: reported, blocked } = applyBlocker(
            existing,
            { key: args.blockerKey ?? "unknown", text: args.blocker ?? "" },
            deps.options.blockedThreshold,
            now,
          )
          const goal = applyBudget(reported, now)
          await deps.repo.save(sessionID, goal)
          const result = buildToolResult(goal)
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
