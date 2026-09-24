export interface Options {
  readonly tokenBudget?: number
  readonly maxGoalTokenBudget?: number
  readonly maxObjectiveChars: number
  readonly blockedThreshold: number
  readonly emptyThreshold: number
  readonly reconcileGuardMinutes: number
  readonly restrictedAgents: readonly string[]
  readonly commandName: string
}

export const DEFAULT_OPTIONS: Options = {
  maxObjectiveChars: 4000,
  blockedThreshold: 3,
  emptyThreshold: 3,
  reconcileGuardMinutes: 5,
  restrictedAgents: ["plan"],
  commandName: "goal",
}

export function resolveOptions(raw: Record<string, unknown>): Options {
  return {
    tokenBudget: positiveInt(raw.token_budget, "token_budget"),
    maxGoalTokenBudget: positiveInt(raw.max_goal_token_budget, "max_goal_token_budget"),
    maxObjectiveChars: positiveInt(raw.max_objective_chars, "max_objective_chars") ?? DEFAULT_OPTIONS.maxObjectiveChars,
    blockedThreshold: positiveInt(raw.blocked_threshold, "blocked_threshold") ?? DEFAULT_OPTIONS.blockedThreshold,
    emptyThreshold: positiveInt(raw.empty_threshold, "empty_threshold") ?? DEFAULT_OPTIONS.emptyThreshold,
    reconcileGuardMinutes:
      positiveInt(raw.reconcile_guard_minutes, "reconcile_guard_minutes") ?? DEFAULT_OPTIONS.reconcileGuardMinutes,
    restrictedAgents: stringArray(raw.restricted_agents, "restricted_agents") ?? DEFAULT_OPTIONS.restrictedAgents,
    commandName: nonEmptyString(raw.command_name, "command_name") ?? DEFAULT_OPTIONS.commandName,
  }
}

function positiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(`opencode-goal: option "${key}" must be a positive integer`)
  return value
}

function stringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`opencode-goal: option "${key}" must be an array of strings`)
  return value as string[]
}

function nonEmptyString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`opencode-goal: option "${key}" must be a non-empty string`)
  return value
}
