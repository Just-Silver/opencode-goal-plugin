import { GoalError, resume } from "./goal"
import type { Goal } from "./types"

/** 预算命中 → budget-limited。可从 active / blocked / usage-limited 升级（系统本地硬限压倒外部信号与模型主观）。 */
export function applyBudget(goal: Goal, now: number): Goal {
  if (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "usage-limited") return goal
  if (goal.tokenBudget === undefined) return goal
  if (goal.tokensUsed < goal.tokenBudget) return goal
  return { ...goal, status: "budget-limited", updatedAt: now }
}

export interface BudgetChange {
  /** 新预算；`undefined` = 无预算（清空）。 */
  readonly budget: number | undefined
  readonly maxTokenBudget?: number
  readonly now: number
}

/**
 * 随时改预算（不重建目标）。见 spec §3.3：
 * - 校验 → 写入（清空时**真正移除** `tokenBudget` 键）；
 * - 超出已用量 → 交 `applyBudget` 降级（active/blocked/usage-limited → budget-limited）；
 * - 原本 budget-limited 且新额度够用 → 走 `resume` 语义回 active（清 blocker 审计与 lastError）。
 */
export function setBudget(goal: Goal, change: BudgetChange): Goal {
  const { budget, maxTokenBudget, now } = change
  if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0))
    throw new GoalError("invalid-budget", "token_budget must be a positive integer")
  if (budget !== undefined && maxTokenBudget !== undefined && budget > maxTokenBudget)
    throw new GoalError("budget-exceeds-max", `token_budget ${budget} exceeds max_goal_token_budget ${maxTokenBudget}`)
  // 解构剔除旧键：`{ ...goal, tokenBudget: undefined }` 会留下显式键，清空必须真正删除。
  const { tokenBudget: _previous, ...rest } = goal
  const next: Goal = budget === undefined ? { ...rest, updatedAt: now } : { ...rest, tokenBudget: budget, updatedAt: now }
  if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) return applyBudget(next, now)
  if (next.status === "budget-limited") return resume(next, now)
  return next
}
