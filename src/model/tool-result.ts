import type { Goal, GoalStatus } from "./types"

export interface GoalView {
  readonly goalId: string
  readonly status: GoalStatus
  readonly objective: string
  readonly tokenBudget: number | null
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly blockerKey: string | null
  readonly blockerText: string | null
  readonly blockerStreak: number
  readonly emptyStreak: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ToolResult {
  readonly goal: GoalView
  readonly remainingTokens: number | null
  readonly completionBudgetReport: string
  readonly blockerStreak?: number
}

/**
 * 工具返回值。`objective` 始终是全文（模型靠 `goal(op="get")` 取回完整目标，
 * 故此处不做截断；截断只发生在提示词注入）。
 */
export function buildToolResult(goal: Goal): ToolResult {
  const remaining = goal.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed)
  const completionBudgetReport =
    goal.tokenBudget === undefined
      ? `no token budget; tokens used ${goal.tokensUsed}`
      : `tokens used ${goal.tokensUsed} / budget ${goal.tokenBudget}; remaining ${remaining}`
  return {
    goal: {
      goalId: goal.goalId,
      status: goal.status,
      objective: goal.objective,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      blockerKey: goal.blockerKey ?? null,
      blockerText: goal.blockerText ?? null,
      blockerStreak: goal.blockerStreak,
      emptyStreak: goal.emptyStreak,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    },
    remainingTokens: remaining,
    completionBudgetReport,
    ...(goal.blockerStreak > 0 ? { blockerStreak: goal.blockerStreak } : {}),
  }
}
