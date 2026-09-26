import type { Rpc } from "@opencode/plugin/rpc"

/**
 * 命令回执通道：服务端发射 `notice` 事件，TUI 订阅后以 **toast** 提示。
 *
 * ⚠️ 订阅方拿到的回调参数是**包装对象**，payload 在 `event.data`
 * （`RpcEventPayload = { type: "rpc.opencode-goal.notice", data: {…} }`）。
 *
 * 纯对象字面量（不调用 `Rpc.define`）→ 零运行时依赖；`@opencode/*` 仅 `import type`。
 */
export const GoalRpc = {
  id: "opencode-goal",
  methods: {},
  events: {
    notice: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
        },
        required: ["sessionID", "message"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition

/** `notice` 事件的回调载荷（包装对象里的 `data`）。 */
export interface GoalNotice {
  readonly sessionID: string
  readonly title?: string
  readonly message: string
}
