import { format, type Messages } from "../i18n/messages"
import type { StopReason } from "../model/types"

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

/** toast 正文区宽度：宿主 `toast.tsx` 的 `maxWidth` 是 `min(60, 终端宽-6)`，去掉边框与内边距约 54 列。 */
export const NOTICE_TOAST_COLUMNS = 54
/** toast 没有 `maxHeight`、也没有滚动，超高部分会被硬裁；这里主动封顶（约 12 行，普通终端放得下）。 */
export const NOTICE_TOAST_MAX_ROWS = 12

/**
 * 把回执正文压到 toast 能完整显示的范围内：按「显示行数」（含自动换行估算）封顶，
 * 超出部分折叠成一行标记。返回**最终给用户看的正文**（调用点在 `notify`）。
 */
export function clampNotice(
  message: string,
  messages: Messages,
  maxRows = NOTICE_TOAST_MAX_ROWS,
  columns = NOTICE_TOAST_COLUMNS,
): string {
  const lines = message.split("\n")
  const kept: string[] = []
  let rows = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const lineRows = line.length === 0 ? 1 : Math.ceil(line.length / columns)
    if (rows + lineRows > maxRows) {
      return [...kept, format(messages["notice.truncated"], { count: lines.length - index })].join("\n")
    }
    rows += lineRows
    kept.push(line)
  }
  return kept.join("\n")
}

/**
 * 停摆回执里**给人看**的那一行（经 `announce` → 会话合成消息的 `description`，落转录、不会像 toast 那样消失）。
 * `status` 由调用点收窄为信号或其预算升级后的终态（usage-limited / blocked / budget-limited）。
 */
export function signalNotice(messages: Messages, status: StopReason, message: string): string {
  const flat = message.replace(/\s+/g, " ").trim()
  const detail = flat.length === 0 ? "" : format(messages["signal.detail"], { message: flat })
  return format(messages[`signal.${status}`], { detail })
}
