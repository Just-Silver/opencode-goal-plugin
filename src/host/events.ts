import { resetBlockerStreak } from "../model/blocked"
import { applyTurn } from "../model/empty"
import { pause } from "../model/goal"
import { applyBudget } from "../model/limits"
import { accrue, type TokenDelta } from "../model/usage"
import type { Goal } from "../model/types"
import type { Continuation } from "./continuation"
import type { GoalDeps } from "./deps"
import { createTurnTracker, type TurnTracker } from "./turn"

export interface EventLike {
  readonly type: string
  readonly data?: Record<string, unknown>
}

export interface EventRouter {
  handle(event: EventLike): Promise<void>
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function createEventRouter(deps: GoalDeps, continuation: Continuation): EventRouter {
  const agents = new Map<string, string>()
  const pendingAutomatic = new Set<string>()
  const blockedThisTurn = new Map<string, boolean>()
  const stepStartedAt = new Map<string, number>()
  const trackers = new Map<string, TurnTracker>()
  const turnOpen = new Set<string>()

  // 轮状态按会话分键：避免 A 的 automatic 事实被 B 的 idle 结算。
  const tracker = (sessionID: string): TurnTracker => {
    let current = trackers.get(sessionID)
    if (!current) {
      current = createTurnTracker()
      trackers.set(sessionID, current)
    }
    return current
  }

  const save = async (sessionID: string, mutate: (goal: Goal, now: number) => Goal): Promise<void> => {
    const goal = await deps.repo.load(sessionID)
    if (!goal) return
    const now = deps.now()
    await deps.repo.save(sessionID, applyBudget(mutate(goal, now), now))
  }

  return {
    async handle(event) {
      const data = event.data ?? {}
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return

      switch (event.type) {
        case "session.agent.selected": {
          if (typeof data.agent === "string") agents.set(sessionID, data.agent)
          return
        }

        case "session.created": {
          // 会话创建时携带的 agent：插件重启/未经过 switchAgent 时也要记下，供续跑限制判定。
          if (typeof data.agent === "string") agents.set(sessionID, data.agent)
          return
        }

        case "session.step.started": {
          if (typeof data.agent === "string") agents.set(sessionID, data.agent)
          stepStartedAt.set(sessionID, typeof data.started === "number" ? data.started : deps.now())
          return
        }

        case "session.step.ended": {
          const tokens = (data.tokens ?? {}) as Record<string, unknown>
          const cache = (tokens.cache ?? {}) as Record<string, unknown>
          const delta: TokenDelta = {
            input: num(tokens.input),
            output: num(tokens.output),
            reasoning: num(tokens.reasoning),
            cacheWrite: num(cache.write),
          }
          const started = stepStartedAt.get(sessionID)
          const elapsed = started === undefined ? 0 : Math.max(0, (deps.now() - started) / 1000)
          stepStartedAt.delete(sessionID)
          await save(sessionID, (goal, now) => accrue(goal, delta, elapsed, now))
          return
        }

        case "session.text.ended":
        case "session.reasoning.ended": {
          if (typeof data.text === "string" && data.text.trim().length > 0) tracker(sessionID).markActivity()
          return
        }

        case "session.tool.called": {
          tracker(sessionID).markActivity()
          const input = data.input
          if (typeof input === "object" && input !== null && (input as Record<string, unknown>).op === "block")
            blockedThisTurn.set(sessionID, true)
          return
        }

        case "session.status": {
          const status = (data.status ?? {}) as Record<string, unknown>
          const kind = typeof status.type === "string" ? status.type : "unknown"

          // 只按轮的开合边沿动作：重复 busy / busy→retry→busy 不重启轮；
          // 未开轮时的 idle（首个 idle、retry→idle）不结算、不续跑。
          if (kind === "busy" && !turnOpen.has(sessionID)) {
            turnOpen.add(sessionID)
            tracker(sessionID).start(pendingAutomatic.delete(sessionID))
            blockedThisTurn.set(sessionID, false)
          }

          if (kind === "idle" && turnOpen.has(sessionID)) {
            turnOpen.delete(sessionID)
            const facts = tracker(sessionID).finish()
            const reportedBlocker = blockedThisTurn.get(sessionID) === true
            blockedThisTurn.set(sessionID, false)
            let blocked = false
            await save(sessionID, (goal, now) => {
              const result = applyTurn(goal, facts, deps.options.emptyThreshold, now)
              blocked = result.blocked
              // spec §7：某轮未报 block → streak 归零；报了 block 则保留（由本层判定，model 只负责归零）。
              return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
            })
            if (blocked) return
            const goal = await deps.repo.load(sessionID)
            if (!goal || goal.status !== "active") return
            // spec §12：agent 未知时保守跳过续跑，绝不回退成 "build" 放行受限 agent。
            const agent = agents.get(sessionID)
            if (agent === undefined) return
            const injected = await continuation.onIdle(sessionID, agent)
            if (injected) pendingAutomatic.add(sessionID)
          }
          return
        }

        case "session.execution.interrupted": {
          // spec §8：中断（Esc / 关闭 / 超时）→ paused；丢弃未完成轮的残留状态，恢复后默认不自动续。
          turnOpen.delete(sessionID)
          pendingAutomatic.delete(sessionID)
          blockedThisTurn.delete(sessionID)
          stepStartedAt.delete(sessionID)
          trackers.delete(sessionID)
          await save(sessionID, (goal, now) => (goal.status === "active" ? pause(goal, now) : goal))
          return
        }

        case "session.deleted": {
          await deps.repo.remove(sessionID)
          agents.delete(sessionID)
          pendingAutomatic.delete(sessionID)
          blockedThisTurn.delete(sessionID)
          stepStartedAt.delete(sessionID)
          trackers.delete(sessionID)
          turnOpen.delete(sessionID)
          return
        }
      }
    },
  }
}
