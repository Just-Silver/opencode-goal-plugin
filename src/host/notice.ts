import type { GoalStatus } from "../model/types"

/**
 * `session.synthetic` 在 TUI 里只渲染 `description`（notice 行，可换行）；
 * `text` 是给模型的完整内容。这里把提示压成便于扫读的一行，避免整段 prompt 刷屏。
 */
export function noticeLine(label: string, detail: string, max = 72): string {
  const flat = detail.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return label
  const clipped = flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
  return `${label} · ${clipped}`
}

/**
 * 宿主信号改状态后的纯回执行（`session.synthetic` 的 description 与 text 同用）。
 * `status` 由调用点保证是信号或其预算升级后的终态（usage-limited / blocked / budget-limited）。
 */
export function signalNotice(status: GoalStatus, message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  const detail = flat.length === 0 ? "" : `: ${flat}`
  if (status === "usage-limited") return `Goal marked usage-limited${detail}. Use /goal-resume after the limit resets.`
  if (status === "budget-limited") return `Goal marked budget-limited${detail}. Use /goal-resume to continue.`
  return `Goal marked blocked${detail}. Use /goal-resume after resolving it.`
}
