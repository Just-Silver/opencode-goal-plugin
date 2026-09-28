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
  /**
   * 本次模型请求的工具表（宿主 `context` 钩子传入，键为有效工具名）。
   * goal active 时从中移除 `disabledTools`——阻塞式交互工具（`question`）会挂起执行、停摆续跑。
   * 只在当次请求生效，不落库（官方文档：Changes affect only the outgoing model call）。
   */
  readonly tools?: Record<string, unknown>
}

/** 常态轮：注入完整目标上下文（objective + 状态 + 预算 + 行为规则）。走 system，不进转录。 */
export function createContextHook(deps: GoalDeps): (input: ContextInputLike) => Promise<void> {
  return async (input) => {
    const goal = await deps.repo.load(input.sessionID)
    if (!goal || goal.status !== "active") return
    input.system.push({ type: "text", text: goalContext(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }) })
    // 移除阻塞式工具：`question` 调用后执行挂起直到用户回复，而续跑只在轮末注入 → goal 会被无限期停摆。
    if (input.tools) for (const name of deps.options.disabledTools) delete input.tools[name]
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
