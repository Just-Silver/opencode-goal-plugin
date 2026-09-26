import type { Goal, GoalStatus } from "./types"
import { emptyUsage } from "./usage"

export type GoalErrorCode = "budget-exceeds-max" | "not-resumable" | "not-completable" | "invalid-budget"

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

/** 改写状态并刷新 updatedAt；resume 时清空 blocker 审计与 lastError（“恢复即新一轮”）。 */
function next(goal: Goal, status: GoalStatus, now: number, patch: Partial<Goal> = {}): Goal {
  return { ...goal, ...patch, status, updatedAt: now }
}

export function pause(goal: Goal, now: number): Goal {
  if (goal.status !== "active") return goal
  return next(goal, "paused", now)
}

export function resume(goal: Goal, now: number): Goal {
  if (
    goal.status !== "paused" &&
    goal.status !== "blocked" &&
    goal.status !== "budget-limited" &&
    goal.status !== "usage-limited"
  )
    throw new GoalError("not-resumable", `not-resumable: cannot resume a ${goal.status} goal`)
  return next(goal, "active", now, {
    blockerKey: undefined,
    blockerText: undefined,
    blockerStreak: 0,
    emptyStreak: 0,
    lastError: undefined,
  })
}

export function complete(goal: Goal, now: number): Goal {
  if (goal.status !== "active") throw new GoalError("not-completable", `not-completable: cannot complete a ${goal.status} goal`)
  return next(goal, "complete", now)
}

/** 重建目标正文（用户命令）：只替换 objective，状态、预算与全部记账原样保留，仅刷新 updatedAt。 */
export function rebuild(goal: Goal, objective: string, now: number): Goal {
  return { ...goal, objective, updatedAt: now }
}

/**
 * 落账一次自动续跑：计数 +1，并刷新 `lastContinuationAt` / `updatedAt`。
 * 口径 = 目标生命周期累计：`resume` / 暂停 / 各种停下都不重置。
 */
export function recordContinuation(goal: Goal, now: number): Goal {
  return { ...goal, continuations: (goal.continuations ?? 0) + 1, lastContinuationAt: now, updatedAt: now }
}
