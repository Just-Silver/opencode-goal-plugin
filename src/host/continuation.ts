import { continuationPrompt } from "../prompts/index"
import type { GoalDeps } from "./deps"

export interface ContinuationPort {
  readonly prompt: (sessionID: string, text: string) => Promise<void>
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
      await port.prompt(sessionID, continuationPrompt(goal, { maxObjectiveChars: deps.options.maxObjectiveChars }))
      const now = deps.now()
      await deps.repo.save(sessionID, { ...goal, lastContinuationAt: now, updatedAt: now })
      return true
    },
  }
}
