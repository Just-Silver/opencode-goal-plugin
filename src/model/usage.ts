import type { Goal } from "./types"

export interface TokenDelta {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheWrite: number
}

/**
 * 记账口径（spec §3/§10）：output + reasoning + cacheWrite。
 * 不计 input、不计 cacheRead —— 只统计“产出侧”消耗。
 */
export function tokenCost(delta: TokenDelta): number {
  return delta.output + delta.reasoning + delta.cacheWrite
}

export function accrue(goal: Goal, delta: TokenDelta, elapsedSeconds: number, now: number): Goal {
  if (goal.status !== "active") return goal
  return {
    ...goal,
    tokensUsed: goal.tokensUsed + tokenCost(delta),
    timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor(elapsedSeconds)),
    updatedAt: now,
  }
}
