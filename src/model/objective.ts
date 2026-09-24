export type ObjectiveCheck =
  | { readonly ok: true; readonly objective: string; readonly injection: string }
  | { readonly ok: false; readonly reason: "empty" }

/**
 * 超限不拒绝：`objective` 保留全文（存 KV），`injection` 截断到 maxChars（注入提示词用）。
 * 调用方在截断时应追加“调用 goal(op="get") 取完整目标”的指引。
 */
export function normalizeObjective(raw: string, maxChars: number): ObjectiveCheck {
  const objective = raw.trim()
  if (objective.length === 0) return { ok: false, reason: "empty" }
  return {
    ok: true,
    objective,
    injection: objective.length <= maxChars ? objective : objective.slice(0, maxChars),
  }
}
