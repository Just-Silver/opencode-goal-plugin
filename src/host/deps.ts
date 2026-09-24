import type { TokenDelta } from "../model/usage"
import type { Options } from "../config"
import type { Repository } from "../store/repository"

/** host 层的全部副作用入口，全部注入以便单测。 */
export interface GoalDeps {
  readonly repo: Repository
  readonly options: Options
  readonly now: () => number
  readonly newGoalId: () => string
  readonly isRestricted: (agentId: string) => boolean
  /** 本插件实例所属 location 的绝对目录（供事件归属过滤，见 events.ts）。 */
  readonly locationDirectory: string
  /** 查询会话所在的 location 目录（事件不带 location 时的归属回落，见 events.ts）。 */
  readonly sessionDirectory: (sessionID: string) => Promise<string | undefined>
  /**
   * 轮内尚未落账的用量（只读）。记账改成「轮内累积、轮末落账」后，KV 在轮中还是旧值，
   * 工具/命令展示时用它叠加，避免 complete 时报告全 0（见 events.ts 的累积器）。
   */
  readonly pendingUsage?: (sessionID: string) => { tokens: TokenDelta; elapsedSeconds: number } | undefined
}
