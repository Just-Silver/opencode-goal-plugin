import { compactionSnapshot, goalContext } from "../prompts/index"
import type { GoalDeps } from "./deps"

/** 与 `@opencode/ai` 的 SystemPart 结构一致（只依赖结构，不引入运行时依赖）。 */
export interface SystemPartLike {
  type: "text"
  text: string
}

export interface ContextInputLike {
  readonly sessionID: string
  readonly agent: string
  readonly system: SystemPartLike[]
}

/** 常态轮：注入完整目标上下文（objective + 状态 + 预算 + 行为规则）。走 system，不进转录。 */
export function createContextHook(deps: GoalDeps): (input: ContextInputLike) => Promise<void> {
  return async (input) => {
    const goal = await deps.repo.load(input.sessionID)
    if (!goal || goal.status !== "active") return
    input.system.push({ type: "text", text: goalContext(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }) })
  }
}

/** 压缩：注入目标快照，保证压缩后模型仍知情（objective/status/预算）。 */
export function createCompactionHook(deps: GoalDeps): (input: ContextInputLike) => Promise<void> {
  return async (input) => {
    const goal = await deps.repo.load(input.sessionID)
    if (!goal) return
    input.system.push({ type: "text", text: compactionSnapshot(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }) })
  }
}
