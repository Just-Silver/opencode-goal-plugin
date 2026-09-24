export interface TurnFacts {
  readonly automatic: boolean
  readonly hasActivity: boolean
}

export interface TurnTracker {
  /** 开启一轮；automatic=true 表示该轮由空闲续跑注入（而非用户触发）。 */
  start(automatic: boolean): void
  /** 记录“有活动”：任意文本/思考/工具调用/提问。 */
  markActivity(): void
  /** 结束当前轮并返回事实，随后重置。 */
  finish(): TurnFacts
}

export function createTurnTracker(): TurnTracker {
  let current: { automatic: boolean; hasActivity: boolean } = { automatic: false, hasActivity: false }
  return {
    start(automatic) {
      current = { automatic, hasActivity: false }
    },
    markActivity() {
      current.hasActivity = true
    },
    finish() {
      const facts = { ...current }
      current = { automatic: false, hasActivity: false }
      return facts
    },
  }
}
