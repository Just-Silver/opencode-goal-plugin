import { resetBlockerStreak } from "../model/blocked"
import { applyTurn } from "../model/empty"
import { pause } from "../model/goal"
import { applyBudget } from "../model/limits"
import { applyHostSignal, hostSignal } from "../model/signals"
import { accrue, addDelta, emptyDelta, type TokenDelta } from "../model/usage"
import type { Goal } from "../model/types"
import type { Continuation } from "./continuation"
import type { GoalDeps } from "./deps"
import { signalNotice } from "./notice"
import { createTurnTracker, type TurnTracker } from "./turn"

export interface EventLike {
  readonly type: string
  readonly data?: Record<string, unknown>
  /** 事件顶层 location。promise 插件订阅的是跨 location 的全局流，用它判归属。 */
  readonly location?: { readonly directory?: unknown }
}

/** 调试用：单条事件的归属判定结果（`/goal-debug events`）。 */
export interface DebugEventRecord {
  readonly at: number
  readonly type: string
  readonly sessionID?: string
  readonly hasLocation: boolean
  readonly location?: string
  readonly decision: "allow" | "drop-other-location" | "drop-unknown-session" | "no-session"
}

/** 调试用：某会话的轮状态快照（`/goal-debug state`）。 */
export interface DebugSessionState {
  readonly sessionID: string
  readonly turnOpen: boolean
  readonly agent?: string
  readonly sessionDirectory: string | null | undefined
  readonly pendingAutomatic: boolean
  readonly blockedThisTurn: boolean
  /** 本会话在跑的后台任务数（后台 shell / 后台 subagent）。 */
  readonly pendingBackground: number
}

export interface DebugSnapshot {
  readonly events: readonly DebugEventRecord[]
  readonly sessions: readonly DebugSessionState[]
}

export interface EventRouter {
  handle(event: EventLike): Promise<void>
  /** 只读诊断视图，供调试命令/工具使用；不参与任何业务判定。 */
  diagnostics(): DebugSnapshot
  /** 轮内尚未落账的用量（只读；工具/命令展示用，不参与业务判定）。 */
  pendingUsage(sessionID: string): { tokens: TokenDelta; elapsedSeconds: number } | undefined
}

/** 纯回执出口：把一行提示显示给用户（不唤醒模型）。 */
export type Notify = (sessionID: string, text: string) => Promise<void>

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** 轮内累积的用量：`step.ended` 只累加，轮末一次性落账。 */
interface TurnUsage {
  tokens: TokenDelta
  elapsedSeconds: number
  /** 本轮出现过 active 目标 → 整轮 token 归属目标（覆盖本轮 create/resume/complete）。 */
  touched: boolean
}

/** 事件环只记这些类型，避免被 delta 类高频事件刷屏。 */
const TRACKED_TYPES = new Set([
  "session.created",
  "session.agent.selected",
  "session.status",
  "session.step.started",
  "session.step.ended",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.success",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "session.inbox.enqueued",
])
const DEBUG_EVENT_LIMIT = 50

export function createEventRouter(deps: GoalDeps, continuation: Continuation, notify: Notify): EventRouter {
  const agents = new Map<string, string>()
  const pendingAutomatic = new Set<string>()
  const blockedThisTurn = new Map<string, boolean>()
  const stepStartedAt = new Map<string, number>()
  const trackers = new Map<string, TurnTracker>()
  const turnOpen = new Set<string>()
  const turnUsage = new Map<string, TurnUsage>()
  /**
   * 本会话正在跑的后台任务 key（后台 shell = `shellID`；后台 subagent = 子会话 id）。
   * 非空 → 该会话轮末不自动续跑，等宿主完成通知唤醒（spec §4.1/§4.5）。
   */
  const pendingBackground = new Map<string, Set<string>>()
  /**
   * 已完成的后台任务 key → 完成时刻（`deps.now()`）。用于「完成通知先于起信号到达」的乱序护栏：
   * 瞬时任务（如 `echo`）的完成通知可能先于 `session.tool.success` 到达，若不加护栏会在起信号时
   * 又被加回 pending → 永久 defer。key 全局唯一（shell ID / 子会话 id），不会误挡合法的重新开始。
   */
  const recentlyCompleted = new Map<string, number>()
  const RECENTLY_COMPLETED_TTL_MS = 30_000
  /** 事件不带 location 时的归属回落：会话所在目录缓存（每会话一次查询）。 */
  const sessionLocations = new Map<string, string | null>()
  const belongsToThisLocation = async (sessionID: string): Promise<boolean> => {
    const cached = sessionLocations.get(sessionID)
    if (cached !== undefined) return cached === deps.locationDirectory
    const directory = await deps.sessionDirectory(sessionID)
    sessionLocations.set(sessionID, directory ?? null)
    return directory === deps.locationDirectory
  }

  // 只读诊断环：记录最近若干条「关心的事件 + 归属判定结果」。
  const debugEvents: DebugEventRecord[] = []
  const note = (
    event: EventLike,
    sessionID: string | undefined,
    decision: DebugEventRecord["decision"],
    location?: string,
  ): void => {
    if (!TRACKED_TYPES.has(event.type)) return
    debugEvents.push({
      at: deps.now(),
      type: event.type,
      ...(sessionID === undefined ? {} : { sessionID }),
      hasLocation: location !== undefined,
      ...(location === undefined ? {} : { location }),
      decision,
    })
    if (debugEvents.length > DEBUG_EVENT_LIMIT) debugEvents.splice(0, debugEvents.length - DEBUG_EVENT_LIMIT)
  }

  // 轮状态按会话分键：避免 A 的 automatic 事实被 B 的 idle 结算。
  const tracker = (sessionID: string): TurnTracker => {
    let current = trackers.get(sessionID)
    if (!current) {
      current = createTurnTracker()
      trackers.set(sessionID, current)
    }
    return current
  }

  /** 后台任务「起」：加入 pending；若完成通知已先到（乱序护栏）则不加（spec §4.2）。 */
  const addPendingBackground = (sessionID: string, key: string): void => {
    const at = recentlyCompleted.get(key)
    if (at !== undefined && deps.now() - at <= RECENTLY_COMPLETED_TTL_MS) return
    const keys = pendingBackground.get(sessionID) ?? new Set<string>()
    keys.add(key)
    pendingBackground.set(sessionID, keys)
  }

  /** 只从 pending 移除 key（不记 `recentlyCompleted`）；供 completeBackground/forgetBackground 复用。 */
  const dropPendingKey = (key: string): void => {
    for (const [sid, keys] of pendingBackground) {
      keys.delete(key)
      if (keys.size === 0) pendingBackground.delete(sid)
    }
  }

  /** key 是否仍在任一会话的 pending 中。 */
  const isPendingKey = (key: string): boolean => {
    for (const keys of pendingBackground.values()) if (keys.has(key)) return true
    return false
  }

  /** 记录完成时刻并惰性剪枝（供乱序护栏使用）。 */
  const rememberCompleted = (key: string): void => {
    const now = deps.now()
    recentlyCompleted.set(key, now)
    for (const [k, at] of recentlyCompleted) if (now - at > RECENTLY_COMPLETED_TTL_MS) recentlyCompleted.delete(k)
  }

  /**
   * 后台任务「止」：从所有会话移除该 key。**仅当完成通知先于起信号到达**（key 不在 pending，
   * 移除是 no-op）时才落乱序护栏——正常「起→止」不落护栏，避免同一 key 合法复用
   * （如 continue-existing subagent 复用同一子会话 id）被误挡（spec §4.3）。
   */
  const completeBackground = (key: string): void => {
    if (!isPendingKey(key)) rememberCompleted(key)
    dropPendingKey(key)
  }

  /** 会话删除：强制落护栏，防「删除后迟到的起信号」再入 pending（spec §4.4）。 */
  const forgetBackground = (key: string): void => {
    rememberCompleted(key)
    dropPendingKey(key)
  }

  /** 从完成通知的 metadata 取 key（主路径）。 */
  const completionKeyFromMetadata = (metadata: Record<string, unknown>): string | undefined => {
    if (metadata.source === "shell" && typeof metadata.shellID === "string") return metadata.shellID
    if (metadata.source === "subagent" && typeof metadata.childID === "string") return metadata.childID
    return undefined
  }

  /** 文本兜底：只认通知**最外层**标签，避免正文里的同名标签误伤（spec §4.3）。 */
  const completionKeyFromText = (text: unknown): string | undefined => {
    if (typeof text !== "string") return undefined
    const shell = /^\s*<shell\b[^>]*\sid="([^"]+)"/.exec(text)
    if (shell) return shell[1]
    const subagent = /^\s*<subagent\b[^>]*\ssessionID="([^"]+)"/.exec(text)
    if (subagent) return subagent[1]
    return undefined
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
      if (!sessionID) {
        note(event, undefined, "no-session")
        return
      }

      // 归属判定：promise 版插件的 ctx.event.subscribe() 订阅的是**跨所有 location** 的全局事件流
      // （/api/event），而宿主为**每个 location 各加载一份**本插件（官方文档：ctx.location 是本实例的
      // location，不是它收到的事件/会话的 location）。带 location 的事件直接比较；不带 location 的
      // 事件（session.execution.*）回落到查询会话所在目录，按会话缓存。
      // `session.deleted` 的 payload 只有 sessionID（宿主 schema：`session-event.ts` 的 Deleted = Base），
      // 因此它**永远不带 location**；而归属回落要查的那个会话已经不存在 → 会被判成“不属于本实例”
      // 直接丢弃，记录永远清不掉（真机实测判定就是 `drop-unknown-session`）。
      // 会话已删时归属没有意义，且 remove 幂等（多个 location 的实例重复执行无害）→ 放行它。
      const ownershipExempt = event.type === "session.deleted"
      const directory = event.location?.directory
      const located = typeof directory === "string" ? directory : undefined
      if (!ownershipExempt) {
        if (located !== undefined) {
          if (located !== deps.locationDirectory) {
            note(event, sessionID, "drop-other-location", located)
            return
          }
        } else if (!(await belongsToThisLocation(sessionID))) {
          note(event, sessionID, "drop-unknown-session")
          return
        }
      }
      note(event, sessionID, "allow", located)

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
            cacheRead: num(cache.read),
            cacheWrite: num(cache.write),
          }
          const started = stepStartedAt.get(sessionID)
          const elapsed = started === undefined ? 0 : Math.max(0, (deps.now() - started) / 1000)
          stepStartedAt.delete(sessionID)
          // 只累积、不写库；轮末（或中断）才一次性落账 —— 否则收尾轮（状态已翻成
          // complete/blocked/budget-limited 之后仍在进行的 step）会被漏记。
          const usage = turnUsage.get(sessionID) ?? { tokens: emptyDelta(), elapsedSeconds: 0, touched: false }
          usage.tokens = addDelta(usage.tokens, delta)
          usage.elapsedSeconds += elapsed
          if (!usage.touched) {
            const goal = await deps.repo.load(sessionID)
            if (goal?.status === "active") usage.touched = true
          }
          turnUsage.set(sessionID, usage)
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

        case "session.tool.success": {
          // 后台任务的「起」：仅当结果 metadata 标 `running`（前台结果为 `completed`/缺失 → 排除）。
          const metadata = (data.metadata ?? {}) as Record<string, unknown>
          if (metadata.status !== "running") return
          if (typeof metadata.shellID === "string") addPendingBackground(sessionID, metadata.shellID)
          else if (typeof metadata.sessionID === "string") addPendingBackground(sessionID, metadata.sessionID)
          return
        }

        case "session.inbox.enqueued": {
          // 后台任务的「止」：宿主完成通知走 Session.synthetic → admit → InboxEnqueued（spec §3.2/§4.3）。
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type !== "synthetic") return
          const payload = (item.payload ?? {}) as Record<string, unknown>
          const key =
            completionKeyFromMetadata((payload.metadata ?? {}) as Record<string, unknown>) ??
            completionKeyFromText(payload.text)
          if (key === undefined) return
          completeBackground(key)
          return
        }

        // 轮边界用 session.execution.*（v2 后端真实事件）；session.status 是 deprecated 定义，
        // 后端从不 emit，曾导致轮结算与续跑永不执行（详见 docs 冒烟复盘）。
        case "session.execution.started": {
          // 开轮边沿：一次执行只会 started 一次，重复 started 不重启轮。
          if (turnOpen.has(sessionID)) return
          turnOpen.add(sessionID)
          tracker(sessionID).start(pendingAutomatic.delete(sessionID))
          blockedThisTurn.set(sessionID, false)
          // 轮首就把「当时是否 active」定下来：若状态在本轮首个 step.ended 之前被外部改出 active
          // （例如用户中途 /goal pause），惰性判定会漏掉整轮 token。
          const atStart = await deps.repo.load(sessionID)
          turnUsage.set(sessionID, {
            tokens: emptyDelta(),
            elapsedSeconds: 0,
            touched: atStart?.status === "active",
          })
          return
        }

        case "session.execution.succeeded": {
          // 轮结束才结算；未开轮的结束事件（插件重启后接入）不结算、不续跑。
          if (!turnOpen.has(sessionID)) return
          turnOpen.delete(sessionID)
          const facts = tracker(sessionID).finish()
          const reportedBlocker = blockedThisTurn.get(sessionID) === true
          blockedThisTurn.set(sessionID, false)
          const usage = turnUsage.get(sessionID)
          turnUsage.delete(sessionID)
          let blocked = false
          await save(sessionID, (goal, now) => {
            // 先记账（整轮，含收尾轮），再判空转/blocker，最后 applyBudget 在 save 内统一跑。
            const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
            const result = applyTurn(accrued, facts, deps.options.emptyThreshold, now)
            blocked = result.blocked
            // spec §7：某轮未报 block → streak 归零；报了 block 则保留（由本层判定，model 只负责归零）。
            return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
          })
          if (blocked) return
          // 后台任务在跑 → 本轮不续跑；宿主完成通知会唤醒会话（spec §4.5）。
          if ((pendingBackground.get(sessionID)?.size ?? 0) > 0) return
          const goal = await deps.repo.load(sessionID)
          if (!goal || goal.status !== "active") return
          // spec §12：agent 未知时保守跳过续跑，绝不回退成 "build" 放行受限 agent。
          const agent = agents.get(sessionID)
          if (agent === undefined) return
          const injected = await continuation.onIdle(sessionID, agent)
          if (injected) pendingAutomatic.add(sessionID)
          return
        }

        case "session.execution.failed": {
          // 结算（仅当本插件看到过该轮开始）；failed 永不续跑，避免在报错时形成续跑循环。
          if (turnOpen.has(sessionID)) {
            turnOpen.delete(sessionID)
            const facts = tracker(sessionID).finish()
            const reportedBlocker = blockedThisTurn.get(sessionID) === true
            blockedThisTurn.set(sessionID, false)
            const usage = turnUsage.get(sessionID)
            turnUsage.delete(sessionID)
            await save(sessionID, (goal, now) => {
              const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
              const result = applyTurn(accrued, facts, deps.options.emptyThreshold, now)
              return reportedBlocker ? result.goal : resetBlockerStreak(result.goal)
            })
          }
          // 宿主信号 → 状态（spec §4.3/§4.4）：无论是否开轮都套用（插件重启后接入也要改状态）。
          const signal = hostSignal(data.error)
          if (!signal) return
          const before = await deps.repo.load(sessionID)
          if (!before) return
          await save(sessionID, (goal, now) => applyHostSignal(goal, now, signal))
          const after = await deps.repo.load(sessionID)
          if (after && after.status !== before.status) await notify(sessionID, signalNotice(after.status, signal.message))
          return
        }

        case "session.execution.interrupted": {
          // spec §8：中断（Esc / 关闭 / 超时）→ paused；丢弃未完成轮的残留状态，恢复后默认不自动续。
          // 注意：**不**清 pendingBackground —— 后台 job 独立于 drain，中断取消不到后台任务，
          // 其完成通知仍会到达并清 pending（spec §4.4）。
          turnOpen.delete(sessionID)
          pendingAutomatic.delete(sessionID)
          blockedThisTurn.delete(sessionID)
          stepStartedAt.delete(sessionID)
          trackers.delete(sessionID)
          const usage = turnUsage.get(sessionID)
          turnUsage.delete(sessionID)
          await save(sessionID, (goal, now) => {
            // 中断也要把中断前已产生的部分轮落账（被中断的那一步若没 emit step.ended，则拿不到其 token）。
            const accrued = usage?.touched ? accrue(goal, usage.tokens, usage.elapsedSeconds, now) : goal
            return accrued.status === "active" ? pause(accrued, now) : accrued
          })
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
          turnUsage.delete(sessionID)
          sessionLocations.delete(sessionID)
          // 后台 subagent 的子会话被删 → 从所有会话 pending 移除该 key，并**强制**记入护栏防「删除后迟到的起信号」再入 pending；
          // 再清本会话自身 pending（spec §4.4）。
          forgetBackground(sessionID)
          pendingBackground.delete(sessionID)
          return
        }
      }
    },

    pendingUsage(sessionID) {
      const usage = turnUsage.get(sessionID)
      // 只在本轮 token 会归属目标（touched）时叠加：否则展示值会与轮末落盘值不一致
      // （paused/complete 目标的普通轮不该把本轮用量算到它头上）。
      if (!usage || !usage.touched) return undefined
      return { tokens: usage.tokens, elapsedSeconds: usage.elapsedSeconds }
    },

    diagnostics() {
      const ids = new Set<string>([
        ...agents.keys(),
        ...sessionLocations.keys(),
        ...trackers.keys(),
        ...turnOpen,
        ...pendingBackground.keys(),
      ])
      return {
        events: [...debugEvents],
        sessions: [...ids].map((sessionID) => ({
          sessionID,
          turnOpen: turnOpen.has(sessionID),
          ...(agents.has(sessionID) ? { agent: agents.get(sessionID) } : {}),
          sessionDirectory: sessionLocations.get(sessionID),
          pendingAutomatic: pendingAutomatic.has(sessionID),
          blockedThisTurn: blockedThisTurn.get(sessionID) === true,
          pendingBackground: pendingBackground.get(sessionID)?.size ?? 0,
        })),
      }
    },
  }
}
