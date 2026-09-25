import { format } from "../i18n/messages"
import { recordContinuation } from "../model/goal"
import { continuationTrigger } from "../prompts/index"
import type { GoalDeps } from "./deps"
import { noticeLine } from "./notice"

export interface ContinuationPort {
  /**
   * 投递一轮续跑。走 `session.synthetic`（`resume: true` 唤醒模型）而非 `session.prompt`：
   * synthetic 在 TUI 里只显示 `description` 一行。
   *
   * 关键：`text` **只发一行触发语** —— 目标本体与规则由 `ctx.session.hook("context")`
   * 以 system 部分注入（不落消息），所以每轮不会把整段目标上下文写进会话历史。
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
      const count = (goal.continuations ?? 0) + 1
      await port.deliver({
        sessionID,
        text: continuationTrigger(),
        description: noticeLine(format(deps.messages["label.autoContinue"], { count }), goal.objective),
      })
      await deps.repo.save(sessionID, recordContinuation(goal, deps.now()))
      return true
    },
  }
}
