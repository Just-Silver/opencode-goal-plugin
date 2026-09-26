import { Plugin } from "@opencode/plugin/tui"
import { GoalRpc, type GoalNotice } from "./rpc"

/**
 * TUI 入口：只订阅服务端命令回执事件并弹 **toast**（宿主渲染、插件只传数据），
 * 不渲染 JSX、不依赖 Solid → 天然绕过「双 Solid 运行时」问题，npm 配置安装也能用。
 *
 * 事件是**广播**给同一 location 下所有 TUI 客户端的，所以这里必须按会话过滤：
 * 只有本窗口正看着该会话时才提示，否则换个窗口敲命令会在所有窗口都冒出来（实测踩坑）。
 * 正文长度由服务端 `clampNotice` 封顶（toast 没有滚动，超屏会被硬裁）。
 */
export default Plugin.define({
  id: "opencode-goal",
  setup(context) {
    const goal = context.client.rpc(GoalRpc)
    const off = goal.events.on("notice", (event) => {
      const data = event.data as unknown as Partial<GoalNotice>
      if (typeof data.sessionID !== "string" || typeof data.message !== "string") return
      const route = context.ui.router.current()
      if (route.type !== "session") return
      if (context.data.session.root(route.sessionID) !== context.data.session.root(data.sessionID)) return
      context.ui.toast.show({
        sessionID: data.sessionID,
        title: typeof data.title === "string" ? data.title : "Goal",
        message: data.message,
        variant: "info",
      })
    })
    return () => {
      off()
    }
  },
})
