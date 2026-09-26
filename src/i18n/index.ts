import type { Language } from "./language"
import type { Messages } from "./messages"
import en from "./en"
import zhCN from "./zh-CN"

export const MESSAGES: Record<Language, Messages> = {
  en,
  "zh-CN": zhCN,
}

export function messagesFor(language: Language): Messages {
  return MESSAGES[language]
}

export type { Language } from "./language"
export type { Messages, MessageKey } from "./messages"
export { format, formatDuration, statusLabel } from "./messages"
export { resolveLanguage, systemLocale, toLanguage } from "./language"
