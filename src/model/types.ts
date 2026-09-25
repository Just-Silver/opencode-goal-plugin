export type GoalStatus = "active" | "paused" | "blocked" | "budget-limited" | "usage-limited" | "complete"

/** 累计 token 分项（0.1.1 起记录；旧记录可能没有）。`tokensUsed` = 五项之和。 */
export interface GoalUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** 宿主终态信号落下的最近一次错误（展示用；与模型报障的 blocker* 字段无关）。 */
export interface GoalLastError {
  readonly type: string
  readonly message: string
  readonly at: number
}

export interface Goal {
  readonly version: 1
  readonly goalId: string
  readonly objective: string
  readonly status: GoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed: number
  /** 分项累计。旧记录（0.1.0 及以前）没有这个字段，缺省时只展示总量。 */
  readonly usage?: GoalUsage
  readonly timeUsedSeconds: number
  readonly blockerKey?: string
  readonly blockerText?: string
  readonly blockerStreak: number
  readonly emptyStreak: number
  /** 最近一次宿主终态错误；仅由 host 信号写入，resume 时清空。 */
  readonly lastError?: GoalLastError
  readonly lastContinuationAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** 未结束（存在即视为“有目标”），只有 complete 是终态。 */
export function isOpenStatus(status: GoalStatus): boolean {
  return status !== "complete"
}
