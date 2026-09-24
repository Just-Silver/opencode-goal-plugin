import type { Repository } from "./repository"

export interface ReconcileOptions {
  readonly repo: Repository
  readonly sessionExists: (sessionID: string) => Promise<boolean>
  readonly guardMs: number
  readonly now: number
}

/**
 * 启动兜底：仅删“存在本地记录 + 会话确实不存在 + 超出保护窗”的孤儿。
 * 任何读取/探测失败一律跳过（宁可留，不可误删）。保护窗等价于旧的 mtime 保险。
 */
export async function reconcile(options: ReconcileOptions): Promise<{ removed: readonly string[] }> {
  const removed: string[] = []
  let all: Array<{ sessionID: string; goal: { updatedAt: number } }>
  try {
    all = await options.repo.listAll()
  } catch {
    return { removed }
  }
  for (const item of all) {
    if (options.now - item.goal.updatedAt <= options.guardMs) continue
    let alive: boolean
    try {
      alive = await options.sessionExists(item.sessionID)
    } catch {
      continue
    }
    if (alive) continue
    try {
      await options.repo.remove(item.sessionID)
      removed.push(item.sessionID)
    } catch {
      // 忽略单条删除失败
    }
  }
  return { removed }
}
