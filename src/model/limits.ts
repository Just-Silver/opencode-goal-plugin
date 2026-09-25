import type { Goal } from "./types"

/** 预算命中 → budget-limited。可从 active / blocked / usage-limited 升级（系统本地硬限压倒外部信号与模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "usage-limited") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}
