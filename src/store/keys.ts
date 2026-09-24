export const KEY_PREFIX = "goal:"

export function goalKey(sessionID: string): string {
  return `${KEY_PREFIX}${sessionID}`
}

export function parseGoalKey(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const sessionID = key.slice(KEY_PREFIX.length)
  return sessionID.length === 0 ? undefined : sessionID
}

/**
 * 宿主会话 id 的形态：必须以 `ses` 开头。
 * 其它形式（如早期探针留下的 `__diag__/...`）会被 API 以 400 拒绝
 * （`Expected a string starting with "ses"`），所以这类键不可能是真实会话。
 */
export function isSessionID(value: string): boolean {
  return value.startsWith("ses")
}
