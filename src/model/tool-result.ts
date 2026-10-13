import type { Goal } from "./types"
import { newWorkOf, usageIsComplete } from "./usage"

/** 无目标时的工具返回。 */
export const NO_GOAL_RESULT = "No goal is set for this session."

/**
 * 耗时短格式。工具输出**不本地化**（见 AGENTS.md），故不经 `i18n.formatDuration`，
 * 单位固定为 `d/h/m/s`。
 */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const unit = (n: number, suffix: string) => `${n}${suffix}`
  const join = (first: string, second: string | undefined) => (second ? `${first} ${second}` : first)
  if (total < 60) return unit(total, "s")
  const minutes = Math.floor(total / 60)
  if (total < 3600) {
    const rest = total % 60
    return join(unit(minutes, "m"), rest > 0 ? unit(rest, "s") : undefined)
  }
  const hours = Math.floor(total / 3600)
  if (total < 86400) {
    const rest = Math.floor((total % 3600) / 60)
    return join(unit(hours, "h"), rest > 0 ? unit(rest, "m") : undefined)
  }
  const rest = Math.floor((total % 86400) / 3600)
  return join(unit(Math.floor(total / 86400), "d"), rest > 0 ? unit(rest, "h") : undefined)
}

function tokenLine(goal: Goal): string {
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）；
  // 两项都为 0 时是无信息噪声（如全新目标），同样省略。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : null
  const newWork = usage ? newWorkOf(usage) : 0
  const breakdown = usage && (usage.cacheRead > 0 || newWork > 0) ? ` · cache read ${usage.cacheRead}, new work ${newWork}` : ""
  if (goal.tokenBudget === undefined) return `Tokens: ${goal.tokensUsed} used (no budget)${breakdown}`
  const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed)
  return `Tokens: ${goal.tokensUsed} used / ${goal.tokenBudget} budget · ${remaining} remaining${breakdown}`
}

/**
 * 工具返回值：**紧凑文本**，只列对模型有决策价值的事实，空值 / 零值行直接省略。
 *
 * `objective` 始终是全文——模型靠 `goal(op="get")` 取回完整目标，故此处不做截断；
 * 截断只发生在提示词注入。
 */
export function buildToolResult(goal: Goal): string {
  const lines = [`Goal: ${goal.objective}`, `Status: ${goal.status}`, tokenLine(goal)]
  if (goal.timeUsedSeconds > 0) lines.push(`Active work: ${formatElapsed(goal.timeUsedSeconds)}`)
  if ((goal.continuations ?? 0) > 0) lines.push(`Auto-continues: ${goal.continuations}`)
  if (goal.blockerStreak > 0 || goal.blockerKey) {
    const text = goal.blockerText ? ` — ${goal.blockerText}` : ""
    lines.push(`Blocker: "${goal.blockerKey ?? "unknown"}" reported ${goal.blockerStreak}x${text}`)
  }
  if (goal.lastError) lines.push(`Last error: ${goal.lastError.type}: ${goal.lastError.message}`)
  return lines.join("\n")
}
