/**
 * `session.synthetic` 在 TUI 里只渲染 `description`（notice 行，可换行）；
 * `text` 是给模型的完整内容。这里把提示压成便于扫读的一行，避免整段 prompt 刷屏。
 */
export function noticeLine(label: string, detail: string, max = 72): string {
  const flat = detail.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return label
  const clipped = flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
  return `${label} · ${clipped}`
}
