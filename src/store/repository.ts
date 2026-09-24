import type { Goal, GoalUsage } from "../model/types"
import { KEY_PREFIX, goalKey, parseGoalKey } from "./keys"

export interface StorageLike {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

export interface Repository {
  load(sessionID: string): Promise<Goal | undefined>
  save(sessionID: string, goal: Goal): Promise<void>
  remove(sessionID: string): Promise<void>
  listAll(): Promise<Array<{ sessionID: string; goal: Goal }>>
}

export const STORE_VERSION = 1
const SCAN_PAGE = 100

/** 解码并校验最小形状；版本不符/损坏一律视为“无目标”（不抛，避免拖垮会话）。 */
export function decodeGoal(value: unknown): Goal | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== STORE_VERSION) return undefined
  if (typeof record.goalId !== "string" || typeof record.objective !== "string" || typeof record.status !== "string") return undefined
  if (typeof record.tokensUsed !== "number" || typeof record.timeUsedSeconds !== "number") return undefined
  if (typeof record.blockerStreak !== "number" || typeof record.emptyStreak !== "number") return undefined
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined
  // `usage` 是 0.1.1 起新增的可选字段：形状不对就丢弃该字段、保留目标（不因为一个分项把整条记录判死）。
  if (record.usage !== undefined && !isUsage(record.usage)) {
    const copy: Record<string, unknown> = { ...record }
    delete copy.usage
    return copy as unknown as Goal
  }
  return value as Goal
}

function isUsage(value: unknown): value is GoalUsage {
  if (typeof value !== "object" || value === null) return false
  const u = value as Record<string, unknown>
  return (
    typeof u.input === "number" &&
    typeof u.output === "number" &&
    typeof u.reasoning === "number" &&
    typeof u.cacheRead === "number" &&
    typeof u.cacheWrite === "number"
  )
}

export function createRepository(storage: StorageLike): Repository {
  return {
    async load(sessionID) {
      return decodeGoal(await storage.get(goalKey(sessionID)))
    },
    async save(sessionID, goal) {
      await storage.set(goalKey(sessionID), goal)
    },
    async remove(sessionID) {
      await storage.remove(goalKey(sessionID))
    },
    async listAll() {
      const out: Array<{ sessionID: string; goal: Goal }> = []
      let after: string | undefined
      for (;;) {
        const page = await storage.scan({ prefix: KEY_PREFIX, ...(after === undefined ? {} : { after }), limit: SCAN_PAGE })
        for (const entry of page.entries) {
          const sessionID = parseGoalKey(entry.key)
          const goal = decodeGoal(entry.value)
          if (sessionID && goal) out.push({ sessionID, goal })
        }
        if (!page.next) break
        after = page.next
      }
      return out
    },
  }
}
