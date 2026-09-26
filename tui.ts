// 宿主对「本地插件目录」的 TUI 入口约定（packages/plugin/src/host.ts）：
//   entry(["tui"]) -> path.resolve(dir, "tui")，按扩展名推导（含 .ts / .tsx）。
// npm/git 安装走 `exports["./tui"]`（指向 src/tui.ts），与本文件无关。
export { default } from "./src/tui"
