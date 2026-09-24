import type { Goal, GoalStatus, GoalUsage } from "./types"
import { newWorkOf, usageIsComplete } from "./usage"

export interface GoalView {
  readonly goalId: string
  readonly status: GoalStatus
  readonly objective: string
  readonly tokenBudget: number | null
  readonly tokensUsed: number
  /** 分项累计；旧记录（0.1.0 及以前）为 null。 */
  readonly usage: GoalUsage | null
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
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : null
  const breakdown = usage ? ` (cacheRead ${usage.cacheRead}, new work ${newWorkOf(usage)})` : ""
  const completionBudgetReport =
    goal.tokenBudget === undefined
      ? `no token budget; tokens used ${goal.tokensUsed}${breakdown}`
      : `tokens used ${goal.tokensUsed} / budget ${goal.tokenBudget}; remaining ${remaining}${breakdown}`
  return {
    goal: {
      goalId: goal.goalId,
      status: goal.status,
      objective: goal.objective,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed,
      usage,
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
