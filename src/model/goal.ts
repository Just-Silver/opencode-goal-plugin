import type { Goal, GoalStatus } from "./types"
import { emptyUsage } from "./usage"

export type GoalErrorCode = "budget-exceeds-max" | "not-resumable" | "not-completable"

export class GoalError extends Error {
  readonly code: GoalErrorCode
  constructor(code: GoalErrorCode, message: string) {
    super(message)
    this.name = "GoalError"
    this.code = code
  }
}

export interface CreateInput {
  readonly goalId: string
  readonly objective: string
  readonly now: number
  readonly tokenBudget?: number
  readonly maxTokenBudget?: number
}

export function createGoal(input: CreateInput): Goal {
  if (input.tokenBudget !== undefined && input.maxTokenBudget !== undefined && input.tokenBudget > input.maxTokenBudget)
    throw new GoalError("budget-exceeds-max", `token_budget ${input.tokenBudget} exceeds max_goal_token_budget ${input.maxTokenBudget}`)
  return {
    version: 1,
    goalId: input.goalId,
    objective: input.objective,
    status: "active",
    ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
    tokensUsed: 0,
    usage: emptyUsage(),
    timeUsedSeconds: 0,
    blockerStreak: 0,
    emptyStreak: 0,
    createdAt: input.now,
    updatedAt: input.now,
  }
}

/** 改写状态并刷新 updatedAt；resume 时清空 blocker 审计（“恢复即新一轮审计”）。 */
function next(goal: Goal, status: GoalStatus, now: number, patch: Partial<Goal> = {}): Goal {
  return { ...goal, ...patch, status, updatedAt: now }
}

export function pause(goal: Goal, now: number): Goal {
  if (goal.status !== "active") return goal
  return next(goal, "paused", now)
}

export function resume(goal: Goal, now: number): Goal {
  if (goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "budget-limited")
    throw new GoalError("not-resumable", `not-resumable: cannot resume a ${goal.status} goal`)
  return next(goal, "active", now, { blockerKey: undefined, blockerText: undefined, blockerStreak: 0, emptyStreak: 0 })
}

export function complete(goal: Goal, now: number): Goal {
  if (goal.status !== "active") throw new GoalError("not-completable", `not-completable: cannot complete a ${goal.status} goal`)
  return next(goal, "complete", now)
}

/** 用户放弃（/goal clear 或模型 drop）：结束目标并清空审计。 */
export function drop(goal: Goal, now: number): Goal {
  return next(goal, "complete", now, { blockerKey: undefined, blockerStreak: 0 })
}
