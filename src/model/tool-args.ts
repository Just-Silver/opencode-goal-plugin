export type ToolOp = "create" | "get" | "complete" | "resume" | "drop" | "block" | "budget"

const OPS: readonly ToolOp[] = ["create", "get", "complete", "resume", "drop", "block", "budget"]

export interface ToolArgs {
  readonly op: ToolOp
  readonly objective?: string
  readonly tokenBudget?: number
  readonly blockerKey?: string
  readonly blocker?: string
}

export type ToolArgsResult = { readonly ok: true; readonly args: ToolArgs } | { readonly ok: false; readonly message: string }

/** 工具输入是 `unknown`（宿主按 JSON Schema 传入）。此处做全部校验并映射为内部驼峰字段。 */
export function parseToolArgs(raw: unknown): ToolArgsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, message: "goal: input must be an object" }
  const record = raw as Record<string, unknown>
  const op = record.op
  if (typeof op !== "string" || !OPS.includes(op as ToolOp))
    return { ok: false, message: `goal: op must be one of ${OPS.join(", ")}` }
  let tokenBudget: number | undefined
  if (record.token_budget !== undefined) {
    if (typeof record.token_budget !== "number" || !Number.isInteger(record.token_budget) || record.token_budget < 0)
      return { ok: false, message: "goal: token_budget must be a non-negative integer (0 = no budget)" }
    tokenBudget = record.token_budget
  }
  return {
    ok: true,
    args: {
      op: op as ToolOp,
      ...(typeof record.objective === "string" ? { objective: record.objective } : {}),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(typeof record.blocker_key === "string" ? { blockerKey: record.blocker_key } : {}),
      ...(typeof record.blocker === "string" ? { blocker: record.blocker } : {}),
    },
  }
}
