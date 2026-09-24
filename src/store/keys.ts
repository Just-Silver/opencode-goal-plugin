export const KEY_PREFIX = "goal:"

export function goalKey(sessionID: string): string {
  return `${KEY_PREFIX}${sessionID}`
}

export function parseGoalKey(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const sessionID = key.slice(KEY_PREFIX.length)
  return sessionID.length === 0 ? undefined : sessionID
}
