import type { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./config"
import { createCommandHandlers } from "./host/commands"
import { createContinuation } from "./host/continuation"
import { createDebug } from "./host/debug"
import { GoalRpc } from "./rpc"
import type { GoalDeps } from "./host/deps"
import { createEventRouter, type EventLike, type EventRouter } from "./host/events"
import { acquireGeneration } from "./host/generation"
import { createCompactionHook, createContextHook } from "./host/hooks"
import { clampNotice, signalNotice } from "./host/notice"
import { isRestrictedAgent } from "./host/plan"
import { createGoalTool } from "./host/tools"
import { messagesFor, resolveLanguage, systemLocale } from "./i18n"
import type { StopReason } from "./model/types"
import { stopWrapUpPrompt } from "./prompts"
import { createRepository } from "./store/repository"
import { isMissingSessionError } from "./store/session-exists"
import { isSessionID } from "./store/keys"
import { reconcile } from "./store/reconcile"

const PLUGIN_ID = "opencode-goal"

export default {
  id: PLUGIN_ID,
  async setup(ctx: Plugin.Context) {
    const options = resolveOptions(ctx.options)
    const language = resolveLanguage(options.language, systemLocale())
    const messages = messagesFor(language)
    const repo = createRepository(ctx.storage)
    // 进程级代际：同 location 的新一代会 abort 上一代（宿主在 location 活跃时 reload 不会调旧代
    // 的 cleanup，旧代的事件订阅会泄漏，续跑被重复投递 N 倍且内存只增不减）。见 known-issues。
    const generation = acquireGeneration(ctx.location.directory)
    // 事件路由稍后才建；先留引用，让工具/命令在展示时能叠加「轮内尚未落账的用量」。
    let routerRef: EventRouter | undefined
    const deps: GoalDeps = {
      repo,
      options,
      messages,
      now: () => Date.now(),
      newGoalId: () => crypto.randomUUID(),
      isRestricted: (agentId) => isRestrictedAgent(agentId, options.restrictedAgents),
      locationDirectory: ctx.location.directory,
      sessionDirectory: async (sessionID) => {
        try {
          const session = await ctx.session.get({ sessionID })
          return session.location?.directory
        } catch {
          return undefined
        }
      },
      pendingUsage: (sessionID) => routerRef?.pendingUsage(sessionID),
    }

    // 投递给模型的入口一律走 synthetic：TUI 只显示 `description` 一行（否则整段 prompt 会刷屏），
    // `text` 仍是模型收到的完整内容（`to-llm-message` 里 synthetic → role "user"）。
    const deliver = (input: { sessionID: string; text: string; description: string }) =>
      ctx.session
        .synthetic({ sessionID: input.sessionID, text: input.text, description: input.description, resume: true })
        .then(() => undefined)
    // 纯回执：**不写会话消息**（0 token、不污染模型上下文），改为发 RPC 事件 → TUI 弹窗。
    // 无 TUI / RPC 不可用时静默（操作已生效）。见规格 §5/§7。
    const noticeRegistration = await ctx.rpc.register(GoalRpc, {}).catch((error) => {
      console.error("opencode-goal: rpc register failed", error)
      return undefined
    })
    // 命令回执：toast（RPC 事件 → TUI，不进模型、0 token，见规格 §16）。
    const notify = async (sessionID: string, text: string) => {
      if (!noticeRegistration) return
      try {
        await noticeRegistration.events.emit("notice", {
          sessionID,
          title: messages["notice.title"],
          message: clampNotice(text, messages),
        })
      } catch (error) {
        console.error("opencode-goal: notice emit failed", error)
      }
    }

    // 目标停摆回执（预算命中 / 用量受限 / 受阻）：走**合成消息 + `resume: true`**。
    // 必须唤醒：`resume: false` 只是把消息塞进收件箱，而停摆发生在轮末（忙期已 settle，没有 drain 再来
    // 投递它）→ 转录不建行、模型读不到，等于没发。唤醒的代价是一轮模型调用，所以 `text` 明确要求收尾
    // （prompts.stopWrapUpPrompt），让这一轮不是白跑；`description` 才是给人看、会留在转录里的那一行。
    const announce = (sessionID: string, input: { reason: StopReason; message: string }) =>
      ctx.session
        .synthetic({
          sessionID,
          text: stopWrapUpPrompt(input.reason),
          description: signalNotice(messages, input.reason, input.message),
          resume: true,
        })
        .then(() => undefined)

    // 事件路由先建：命令/工具/调试视图都要引用它。
    const continuation = createContinuation(deps, { deliver })
    const router = createEventRouter(deps, continuation, announce)
    routerRef = router
    const debug = createDebug(deps, { pluginId: PLUGIN_ID, snapshot: () => router.diagnostics() })

    // 恢复/解锁后的「激活」：**只在会话空闲时**投递一轮续跑。
    // 会话在跑时投递会被宿主当成 steer 插进当前轮（不是我们要的效果），而它本轮末自然会续。
    const activate = async (sessionID: string): Promise<"delivered" | "busy" | "skipped"> => {
      if (router.isRunning(sessionID)) return "busy"
      const agent = await ctx.session
        .get({ sessionID })
        .then((session) => session.agent)
        .catch(() => undefined)
      if (agent === undefined) return "skipped"
      return (await continuation.onIdle(sessionID, agent)) ? "delivered" : "skipped"
    }

    // 命令：`/goal <目标>` 转发给模型；状态控制是**独立命令**（宿主没有子命令概念，
    // 后台拦截保留名会让用户打错一个字就变成目标文字）。状态控制命令不唤醒模型，回执经 `notify` 走 TUI toast（不写会话消息）。
    ctx.command.transform((editor) => {
      const handlers = createCommandHandlers(deps, { deliver, notify, announce, activate })
      const name = options.commandName
      editor.add({
        name,
        description: messages["cmd.goal"],
        execute: async (input) => handlers.goal({ sessionID: input.sessionID, prompt: { text: input.prompt.text } }),
      })
      editor.add({
        name: `${name}-status`,
        description: messages["cmd.status"],
        execute: async (input) => handlers.status(input.sessionID),
      })
      editor.add({
        name: `${name}-rebuild`,
        description: messages["cmd.rebuild"],
        execute: async (input) => handlers.rebuild(input.sessionID, input.prompt.text),
      })
      editor.add({
        name: `${name}-budget`,
        description: messages["cmd.budget"],
        execute: async (input) => handlers.budget(input.sessionID, input.prompt.text),
      })
      editor.add({
        name: `${name}-pause`,
        description: messages["cmd.pause"],
        execute: async (input) => handlers.pause(input.sessionID),
      })
      editor.add({
        name: `${name}-resume`,
        description: messages["cmd.resume"],
        execute: async (input) => handlers.resume(input.sessionID),
      })
      editor.add({
        name: `${name}-clear`,
        description: messages["cmd.clear"],
        execute: async (input) => handlers.clear(input.sessionID),
      })
      editor.add({
        name: options.debugCommandName,
        description: messages["cmd.debug"],
        execute: async (input) => {
          const text = await debug.render(input.prompt.text, input.sessionID)
          await notify(input.sessionID, text)
        },
      })
    })

    // 工具：goal(op=...)（业务）；debug=true 时额外注册只读的 goal_debug（默认开，可设 false 保持工具表干净）
    ctx.tool.transform((editor) => {
      const tool = createGoalTool(deps)
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        // 直连工具而非 Code Mode 目录：宿主所有内置工具、以及参考实现的 goal 工具都这么设。
        // 否则模型必须写 JS（execute → tools.goal(...)）才能调用，多一层间接又更容易出错。
        options: { codemode: false },
        execute: async (input, context) => tool.execute(input, context),
      })
      if (options.debug) {
        editor.add({
          name: "goal_debug",
          description: messages["tool.debug.description"],
          input: {
            type: "object",
            properties: {
              op: {
                type: "string",
                description: messages["tool.debug.op"],
                enum: ["env", "events", "sessions", "state"],
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (input, context) => ({
            content: await debug.render(String((input as { op?: unknown })?.op ?? ""), context.sessionID),
          }),
        })
      }
    })

    // 钩子：常态轻量提醒 + 压缩快照。陈旧代际（被 reload 顶替、宿主未调 cleanup 的旧激活）
    // 一律 no-op，避免旧图若仍被引用时注入过期上下文。
    const contextHook = createContextHook(deps)
    const compactionHook = createCompactionHook(deps)
    ctx.session.hook("context", (input) => (generation.isCurrent() ? contextHook(input) : Promise.resolve()))
    ctx.session.hook("compaction", (input) => (generation.isCurrent() ? compactionHook(input) : Promise.resolve()))

    // 事件：记账、轮边界、空闲续跑、会话删除。signal 来自代际：被新一代顶替时宿主会关闭旧订阅。
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: generation.signal })) {
          // 顶替后不再处理任何事件（abort 与订阅关闭之间可能还有一条已在途的事件）。
          if (!generation.isCurrent()) break
          // 单个事件失败只记录并继续：否则一次 handle 拒绝会静默终止整条事件循环。
          try {
            await router.handle(event as unknown as EventLike)
          } catch (error) {
            console.error("opencode-goal: event handling failed", error)
          }
        }
      } catch (error) {
        console.error("opencode-goal: event subscription failed", error)
      }
    })()

    // 启动兜底：删孤儿 KV（保护窗内不删；探测失败不删）
    void reconcile({
      repo,
      sessionExists: async (sessionID) => {
        // 伪造的 session id（早期探针留下的脏键）根本过不了宿主校验（400），
        // 直接判定为不存在，交给 reconcile 清掉；否则会被当成“探测失败”永久保留。
        if (!isSessionID(sessionID)) return false
        try {
          await ctx.session.get({ sessionID })
          return true
        } catch (error) {
          // 实测：插件侧抛的是 Schema.TaggedError（Session.NotFoundError / SchemaError），
          // **没有 `status` 字段** —— 只认 `status` 的旧实现在真机上永远探不到「不存在」。
          return !isMissingSessionError(error)
        }
      },
      guardMs: options.reconcileGuardMinutes * 60_000,
      now: Date.now(),
    }).catch(() => undefined)

    return () => {
      generation.release()
      void noticeRegistration?.dispose()
    }
  },
} satisfies Plugin.Plugin
