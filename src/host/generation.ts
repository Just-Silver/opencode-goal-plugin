/**
 * 进程级「代际」登记表 —— 宿主 `location.reload` 泄漏旧插件激活的兜底。
 *
 * 背景（已用隔离探针实证，见 `docs/opencode/known-issues.md`）：
 * `opencode reload` → `LocationServiceMap.reload()` → `RcMap.invalidate(ref)`，而 Effect 的
 * `RcMap.invalidate` 在 `entry.refCount > 0` 时**只摘键、不关闭作用域**。只要该 location 还有
 * 活引用（例如会话正在跑一轮），旧服务图（含插件激活）就不会关闭，插件的 `cleanup`
 * **永远不会被调用**。于是旧激活订阅全局事件流的循环一直跑 → 自动续跑被重复投递 N 倍，
 * 且闭包持续持有 `ctx`/`repo`/`router`，内存只增不减。
 *
 * 兜底：同一 location 的新一代 `setup` 主动 abort 上一代的事件订阅；旧循环随之退出、引用可回收。
 * 登记表挂在 `globalThis`（而非模块级变量）：泄漏的是**独立的模块副本**，模块级变量不共享；
 * `globalThis` 在同一进程内共享，且单线程无竞态。
 */
const REGISTRY_KEY = Symbol.for("opencode-goal.active-generations")

interface Generation {
  readonly token: symbol
  readonly controller: AbortController
}

type Registry = Map<string, Generation>

function registry(): Registry {
  const global = globalThis as { [REGISTRY_KEY]?: Registry }
  let map = global[REGISTRY_KEY]
  if (!map) {
    map = new Map()
    global[REGISTRY_KEY] = map
  }
  return map
}

/**
 * 规范化 location 目录，保证同一 location 的不同实例算出同一个键。
 * Windows 下盘符/路径大小写不敏感，统一小写避免 `E:\` 与 `e:\` 被当成两个 location。
 */
export function generationKey(directory: string): string {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export interface GenerationHandle {
  /** 传给 `ctx.event.subscribe({ signal })`：被顶替时宿主会关闭旧订阅。 */
  readonly signal: AbortSignal
  /** 自己是否仍是该 location 的当班一代；旧代应停止一切投递。 */
  isCurrent(): boolean
  /** 清理：abort 自己；仅当自己仍是当班一代时才注销登记（避免误删新一代）。 */
  release(): void
}

/**
 * 领取某 location 的当前代际。领取即顶替：上一代（若仍存活，说明宿主没调它的 cleanup）会被 abort。
 */
export function acquireGeneration(locationDirectory: string): GenerationHandle {
  const key = generationKey(locationDirectory)
  const map = registry()
  const previous = map.get(key)
  // 上一代没被宿主回收 → 主动按停它的全局事件订阅，并让它的循环自行退出。
  previous?.controller.abort()

  const token = Symbol("opencode-goal.generation")
  const controller = new AbortController()
  map.set(key, { token, controller })

  const isCurrent = () => map.get(key)?.token === token
  return {
    signal: controller.signal,
    isCurrent,
    release() {
      controller.abort()
      // 只有当班的一代才注销；被顶替的旧代不要误删新一代的登记。
      if (isCurrent()) map.delete(key)
    },
  }
}