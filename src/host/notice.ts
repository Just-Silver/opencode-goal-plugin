import { format, type Messages } from "../i18n/messages"

/**
 * `session.synthetic` 在 TUI 里只渲染 `description`（notice 行，可换行）；
 * `text` 是给模型的完整内容。这里把提示压成便于扫读的一行，避免整段 prompt 刷屏。
 *
 * `max` 为裁剪上限（默认 72）；传 `Number.POSITIVE_INFINITY` 表示**不裁剪**——
 * `/goal <目标>` 用它显示用户提交的完整目标（TUI 会自动换行）。
 */
export function noticeLine(label: string, detail: string, max = 72): string {
  const flat = detail.replace(/\s+/g, " ").trim()
  if (flat.length === 0) return label
  const clipped = flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
  return `${label} · ${clipped}`
}

/**
 * 宿主信号改状态后的纯回执行（`session.synthetic` 的 description 与 text 同用）。
 * `status` 由调用点收窄为信号或其预算升级后的终态（usage-limited / blocked / budget-limited）。
 */
export function signalNotice(
  messages: Messages,
  status: "usage-limited" | "budget-limited" | "blocked",
  message: string,
): string {
  const flat = message.replace(/\s+/g, " ").trim()
  const detail = flat.length === 0 ? "" : format(messages["signal.detail"], { message: flat })
  return format(messages[`signal.${status}`], { detail })
}
