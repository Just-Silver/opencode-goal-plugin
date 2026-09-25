import { toLanguage, type Language } from "./i18n/language"

export interface Options {
  readonly tokenBudget?: number
  readonly maxGoalTokenBudget?: number
  readonly maxObjectiveChars: number
  readonly blockedThreshold: number
  readonly emptyThreshold: number
  readonly reconcileGuardMinutes: number
  readonly restrictedAgents: readonly string[]
  readonly commandName: string
  readonly debugCommandName: string
  /** true 时额外注册 `goal_debug` 只读调试工具（默认开，便于 agent 自主诊断；设 false 可让工具表保持干净）。 */
  readonly debug: boolean
  /** 面向用户文案的语言；缺省跟随系统 locale。 */
  readonly language?: Language
}

export const DEFAULT_OPTIONS: Options = {
  maxObjectiveChars: 4000,
  blockedThreshold: 3,
  emptyThreshold: 3,
  reconcileGuardMinutes: 5,
  restrictedAgents: ["plan"],
  commandName: "goal",
  debugCommandName: "goal-debug",
  debug: true,
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
    debugCommandName: nonEmptyString(raw.debug_command_name, "debug_command_name") ?? DEFAULT_OPTIONS.debugCommandName,
    debug: booleanValue(raw.debug, "debug") ?? DEFAULT_OPTIONS.debug,
    language: languageValue(raw.language),
  }
}

function languageValue(value: unknown): Language | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`opencode-goal: option "language" must be "zh-CN" or "en"`)
  const language = toLanguage(value)
  if (language === undefined) throw new Error(`opencode-goal: option "language" must be "zh-CN" or "en"`)
  return language
}

function booleanValue(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`opencode-goal: option "${key}" must be a boolean`)
  return value
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
