import type { Goal } from "./types"

/** 预算命中 → budget-limited。仅从 active 触发；优先级高于 blocked（系统事实压过模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}
