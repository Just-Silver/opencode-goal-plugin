import type { Goal } from "./types"

/** 预算命中 → budget-limited。从 active 或 blocked 触发（可从 blocked 升级）；优先级高于 blocked（系统事实压过模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active" && goal.status !== "blocked") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}
