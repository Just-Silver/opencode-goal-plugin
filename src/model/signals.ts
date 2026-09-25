import type { Goal } from "./types"

export interface HostSignal {
  readonly status: "usage-limited" | "blocked"
  readonly type: string
  readonly message: string
}

/**
 * 宿主终态错误（`session.execution.failed` 的 `data.error`）→ goal 状态。
 * 只映射 spec §4.1 固定的一组；其余（含 no-route/timeout/unsupported 与全部可重试类）返回 undefined。
 */
export function hostSignal(error: unknown): HostSignal | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  const type = record.type
  if (typeof type !== "string" || type.length === 0) return undefined
  const message = typeof record.message === "string" ? record.message : ""
  if (type === "provider.quota") return { status: "usage-limited", type, message }
  if (type === "provider.auth" || type === "provider.content-filter" || type === "provider.invalid-request")
    return { status: "blocked", type, message }
  return undefined
}

/**
 * 状态转移（spec §4.3）：仅当 goal.status ∈ {active, blocked} 时改状态并记 lastError；
 * 其它状态（paused/complete/usage-limited/budget-limited）原样返回同一引用。
 */
export function applyHostSignal(goal: Goal, now: number, signal: HostSignal): Goal {
  if (goal.status !== "active" && goal.status !== "blocked") return goal
  return {
    ...goal,
    status: signal.status,
    lastError: { type: signal.type, message: signal.message, at: now },
    updatedAt: now,
  }
}
