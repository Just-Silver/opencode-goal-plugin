/**
 * `ctx.session.get` 的失败是否等于「会话不存在」。
 *
 * 真机实测（插件侧探针把结果写进 KV）：插件 API 抛的是 Schema.TaggedError，**没有 `status` 字段**：
 *   - 会话不存在  → `{ _tag: "Session.NotFoundError", sessionID }`
 *   - id 形态非法 → `{ _tag: "SchemaError", issue, … }`（`Expected a string starting with "ses"`）
 * 旧实现只认 `status === 404 || 400`，于是这两类都落到「探测失败」分支，孤儿记录永远清不掉。
 *
 * 只把上面这些当作「不存在」；其它错误（500、超时、未知形状）一律算「探测失败」→ 宁可留，不可误删。
 */
export function isMissingSessionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const value = error as { _tag?: unknown; status?: unknown }
  // 历史/HTTP 形态：保留，防止将来桥接层变成直接暴露 HTTP 状态码。
  if (value.status === 404 || value.status === 400) return true
  return value._tag === "Session.NotFoundError" || value._tag === "SchemaError"
}
