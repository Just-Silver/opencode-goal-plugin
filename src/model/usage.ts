import type { Goal, GoalUsage } from "./types"

export interface TokenDelta {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export function emptyUsage(): GoalUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(base: GoalUsage | undefined, delta: TokenDelta): GoalUsage {
  const b = base ?? emptyUsage()
  return {
    input: b.input + delta.input,
    output: b.output + delta.output,
    reasoning: b.reasoning + delta.reasoning,
    cacheRead: b.cacheRead + delta.cacheRead,
    cacheWrite: b.cacheWrite + delta.cacheWrite,
  }
}

export function addDelta(a: TokenDelta, b: TokenDelta): TokenDelta {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function emptyDelta(): TokenDelta {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

/**
 * 预算计量口径：**真实处理量** = input + output + reasoning + cacheRead + cacheWrite。
 *
 * 与 Codex / OMP 的差异是有意的：它们排除 cacheRead（“复用前缀不算新工作”），
 * 那是「工作量」口径；本插件要的是「消耗量」—— 每一轮续跑都会把整个上下文重读一遍，
 * cacheRead 是真实发生的处理量，也是 runaway（空转烧轮）最灵敏的信号。
 * 详见 `docs/superpowers/specs/2026-09-24-opencode-goal-design.md` §3/§10。
 */
export function tokenCost(delta: TokenDelta): number {
  return delta.input + delta.output + delta.reasoning + delta.cacheRead + delta.cacheWrite
}

/** 「新工作量」（不含 cacheRead）：只用于展示/诊断，不参与预算判定。 */
export function newWorkOf(usage: GoalUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheWrite
}

/**
 * 分项是否可信：`usage` 存在且其和恰等于 `tokensUsed`。
 * 旧记录（0.1.0，无 `usage`）在 0.1.1 里被 accrue 后，`usage` 只含升级后的增量，
 * 与 `tokensUsed` 不等 —— 此时**只展示总量，不展示分项**，避免给出对不上的数字。
 */
export function usageIsComplete(goal: Goal): boolean {
  if (!goal.usage) return false
  return tokenCost(goal.usage) === goal.tokensUsed
}

/**
 * 累加一轮的用量与墙钟。**不看状态**：归属判定由调用方在轮末完成
 * （见 `host/events.ts` 的轮内累积器）——否则收尾轮（complete/blocked/budget-limited
 * 之后仍在进行的 step）会被漏记。
 */
/** 只读叠加：把轮内尚未落账的用量合进目标，用于展示（**绝不落盘**，落盘只走 `accrue`）。 */
export function withPending(
  goal: Goal,
  pending: { tokens: TokenDelta; elapsedSeconds: number } | undefined,
): Goal {
  if (!pending) return goal
  return {
    ...goal,
    tokensUsed: goal.tokensUsed + tokenCost(pending.tokens),
    usage: addUsage(goal.usage, pending.tokens),
    timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor(pending.elapsedSeconds)),
  }
}

export function accrue(goal: Goal, delta: TokenDelta, elapsedSeconds: number, now: number): Goal {
  return {
    ...goal,
    tokensUsed: goal.tokensUsed + tokenCost(delta),
    usage: addUsage(goal.usage, delta),
    timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor(elapsedSeconds)),
    updatedAt: now,
  }
}