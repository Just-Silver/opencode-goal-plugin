export type GoalStatus = "active" | "paused" | "blocked" | "budget-limited" | "complete"

export interface Goal {
  readonly version: 1
  readonly goalId: string
  readonly objective: string
  readonly status: GoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly blockerKey?: string
  readonly blockerText?: string
  readonly blockerStreak: number
  readonly emptyStreak: number
  readonly lastContinuationAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** 未结束（存在即视为“有目标”），只有 complete 是终态。 */
export function isOpenStatus(status: GoalStatus): boolean {
  return status !== "complete"
}
