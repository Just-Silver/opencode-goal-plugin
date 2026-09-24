import type { Goal } from "./types"

const MAX_KEY = 64

/** 归一化：trim → NFKC → 小写 → 非 [a-z0-9] 折叠为 '-' → 去首尾 '-' → 截断。不做语义匹配。 */
export function normalizeBlockerKey(raw: string): string {
  const normalized = raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_KEY)
  return normalized.length === 0 ? "unknown" : normalized
}

export interface BlockerReport {
  readonly key: string
  readonly text: string
}

export function applyBlocker(
  goal: Goal,
  report: BlockerReport,
  threshold: number,
  now: number,
): { goal: Goal; blocked: boolean } {
  const key = normalizeBlockerKey(report.key)
  const streak = goal.blockerKey === key ? goal.blockerStreak + 1 : 1
  const blocked = streak >= threshold
  return {
    goal: {
      ...goal,
      blockerKey: key,
      blockerText: report.text,
      blockerStreak: streak,
      status: blocked ? "blocked" : goal.status,
      updatedAt: now,
    },
    blocked,
  }
}

/**
 * 轮边界收尾：该轮未报 block → `blockerStreak=0`（保留 key，下次同 key 从 1 重新计）。
 * 达阈值已被服务端置 blocked 的目标不受影响（只在 active 时归零）。
 */
export function resetBlockerStreak(goal: Goal): Goal {
  if (goal.status !== "active" || goal.blockerStreak === 0) return goal
  return { ...goal, blockerStreak: 0 }
}
