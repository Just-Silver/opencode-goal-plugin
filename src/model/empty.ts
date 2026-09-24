import type { Goal } from "./types"

export interface TurnActivity {
  readonly automatic: boolean
  readonly hasActivity: boolean
}

/**
 * 照抄 Codex：只有 automatic 且无活动的轮才计入空转；用户轮或任意活动都归零。
 * 仅对 active 目标生效（paused/blocked/budget-limited/complete 不动）。
 */
export function applyTurn(
  goal: Goal,
  turn: TurnActivity,
  threshold: number,
  now: number,
): { goal: Goal; blocked: boolean } {
  if (goal.status !== "active") return { goal, blocked: false }
  if (!turn.automatic || turn.hasActivity)
    return { goal: goal.emptyStreak === 0 ? goal : { ...goal, emptyStreak: 0 }, blocked: false }
  const emptyStreak = goal.emptyStreak + 1
  const blocked = emptyStreak >= threshold
  return {
    goal: { ...goal, emptyStreak, status: blocked ? "blocked" : "active", updatedAt: now },
    blocked,
  }
}
