export type Language = "zh-CN" | "en"

/** 取主语言子标签：zh* → zh-CN，en* → en，其余 undefined。大小写与 `_`/`-` 归一。 */
export function toLanguage(tag: string): Language | undefined {
  const primary = tag.trim().toLowerCase().replace(/_/g, "-").split("-")[0]
  if (primary === "zh") return "zh-CN"
  if (primary === "en") return "en"
  return undefined
}

/** 探测系统 locale（ICU，与宿主进程无关）；异常兜底 "en"。 */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return "en"
  }
}

/** 显式优先；否则系统 locale；否则 "en"。 */
export function resolveLanguage(explicit: Language | undefined, locale: string): Language {
  return explicit ?? toLanguage(locale) ?? "en"
}
