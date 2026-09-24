import { continuationPrompt } from "../prompts/index"
import type { GoalDeps } from "./deps"
import { noticeLine } from "./notice"

export interface ContinuationPort {
  /**
   * 投递一轮续跑。走 `session.synthetic`（`resume: true` 唤醒模型）而非 `session.prompt`：
   * synthetic 在 TUI 里只显示 `description` 一行，整段 continuation prompt 不会刷屏。
   */
  readonly deliver: (input: { sessionID: string; text: string; description: string }) => Promise<void>
}

export interface Continuation {
  /** 空闲时调用：仅 active 且非受限 agent 才投递续跑轮，返回是否已投递。 */
  onIdle(sessionID: string, agentId: string): Promise<boolean>
}

export function createContinuation(deps: GoalDeps, port: ContinuationPort): Continuation {
  return {
    async onIdle(sessionID, agentId) {
      const goal = await deps.repo.load(sessionID)
      if (!goal || goal.status !== "active") return false
      if (deps.isRestricted(agentId)) return false
      await port.deliver({
        sessionID,
        text: continuationPrompt(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }),
        description: noticeLine("Goal auto-continue", goal.objective),
      })
      const now = deps.now()
      await deps.repo.save(sessionID, { ...goal, lastContinuationAt: now, updatedAt: now })
      return true
    },
  }
}
