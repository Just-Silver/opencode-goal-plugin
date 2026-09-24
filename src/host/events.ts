import { resetBlockerStreak } from "../model/blocked"
import { applyTurn } from "../model/empty"
import { pause } from "../model/goal"
import { applyBudget } from "../model/limits"
import { accrue, type TokenDelta } from "../model/usage"
import type { Goal } from "../model/types"
import type { Continuation } from "./continuation"
import type { GoalDeps } from "./deps"
import type { TurnTracker } from "./turn"

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

export function createEventRouter(deps: GoalDeps, tracker: TurnTracker, continuation: Continuation): EventRouter {
  const agents = new Map<string, string>()
  const lastStatus = new Map<string, string>()
  const pendingAutomatic = new Set<string>()
  const blockedThisTurn = new Map<string, boolean>()
  let stepStartedAt: number | undefined

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

        case "session.step.started": {
          stepStartedAt = typeof data.started === "number" ? data.started : deps.now()
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
          const elapsed = stepStartedAt === undefined ? 0 : Math.max(0, (deps.now() - stepStartedAt) / 1000)
          stepStartedAt = undefined
          await save(sessionID, (goal, now) => accrue(goal, delta, elapsed, now))
          return
        }

        case "session.text.ended":
        case "session.reasoning.ended": {
          if (typeof data.text === "string" && data.text.trim().length > 0) tracker.markActivity()
          return
        }

        case "session.tool.called": {
          tracker.markActivity()
          const input = data.input
          if (typeof input === "object" && input !== null && (input as Record<string, unknown>).op === "block")
            blockedThisTurn.set(sessionID, true)
          return
        }

        case "session.status": {
          const status = (data.status ?? {}) as Record<string, unknown>
          const kind = typeof status.type === "string" ? status.type : "unknown"
          const previous = lastStatus.get(sessionID)
          lastStatus.set(sessionID, kind)

          if (kind === "busy" && previous !== "busy") {
            tracker.start(pendingAutomatic.delete(sessionID))
            blockedThisTurn.set(sessionID, false)
          }

          if (kind === "idle" && previous !== "idle") {
            const facts = tracker.finish()
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
            const injected = await continuation.onIdle(sessionID, agents.get(sessionID) ?? "build")
            if (injected) pendingAutomatic.add(sessionID)
          }
          return
        }

        case "session.execution.interrupted": {
          // spec §8：中断（Esc / 关闭 / 超时）→ paused；恢复后默认不自动续。
          await save(sessionID, (goal, now) => (goal.status === "active" ? pause(goal, now) : goal))
          return
        }

        case "session.deleted": {
          await deps.repo.remove(sessionID)
          agents.delete(sessionID)
          lastStatus.delete(sessionID)
          pendingAutomatic.delete(sessionID)
          blockedThisTurn.delete(sessionID)
          return
        }
      }
    },
  }
}
