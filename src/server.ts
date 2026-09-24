import type { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./config"
import { createCommandHandler } from "./host/commands"
import { createContinuation } from "./host/continuation"
import { createDebug } from "./host/debug"
import type { GoalDeps } from "./host/deps"
import { createEventRouter, type EventLike } from "./host/events"
import { createCompactionHook, createContextHook } from "./host/hooks"
import { isRestrictedAgent } from "./host/plan"
import { createGoalTool } from "./host/tools"
import { createRepository } from "./store/repository"
import { reconcile } from "./store/reconcile"

const PLUGIN_ID = "opencode-goal"

export default {
  id: PLUGIN_ID,
  async setup(ctx: Plugin.Context) {
    const options = resolveOptions(ctx.options)
    const repo = createRepository(ctx.storage)
    const deps: GoalDeps = {
      repo,
      options,
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
    }

    // 投递给模型的入口一律走 synthetic：TUI 只显示 `description` 一行（否则整段 prompt 会刷屏），
    // `text` 仍是模型收到的完整内容（`to-llm-message` 里 synthetic → role "user"）。
    const deliver = (input: { sessionID: string; text: string; description: string }) =>
      ctx.session
        .synthetic({ sessionID: input.sessionID, text: input.text, description: input.description, resume: true })
        .then(() => undefined)
    // 纯回执：不唤醒模型，`description` 就是给人看的那一行。
    const notify = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, description: text, resume: false }).then(() => undefined)

    // 事件路由先建：命令/工具/调试视图都要引用它。
    const continuation = createContinuation(deps, { deliver })
    const router = createEventRouter(deps, continuation)
    const debug = createDebug(deps, { pluginId: PLUGIN_ID, snapshot: () => router.diagnostics() })

    // 命令：保留名服务端确定性处理；其余转发给模型。调试命令只读、零 token、不走模型。
    ctx.command.transform((editor) => {
      editor.add({
        name: options.commandName,
        description: "Set, inspect, pause, resume, or clear the persistent goal.",
        execute: async (input) => {
          const handler = createCommandHandler(deps, { deliver, notify })
          await handler({ sessionID: input.sessionID, prompt: { text: input.prompt.text } })
        },
      })
      editor.add({
        name: options.debugCommandName,
        description: "Read-only diagnostics for the goal plugin (no model turn).",
        execute: async (input) => {
          const text = await debug.render(input.prompt.text, input.sessionID)
          await notify(input.sessionID, text)
        },
      })
    })

    // 工具：goal(op=...)（业务）；debug=true 时额外注册只读的 goal_debug（默认关，避免污染模型工具表）
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
          description:
            "DEBUG ONLY — read-only diagnostics for the opencode-goal plugin (which location owns this session, recent event-ownership decisions, stored goals, in-memory turn state). Do NOT call this during normal goal work. Call it only when the user explicitly asks to debug the goal plugin, or when goal auto-continuation misbehaves.",
          input: {
            type: "object",
            properties: {
              op: {
                type: "string",
                description: "Which diagnostic to render (debug-only; never call speculatively).",
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

    // 钩子：常态轻量提醒 + 压缩快照
    ctx.session.hook("context", createContextHook(deps))
    ctx.session.hook("compaction", createCompactionHook(deps))

    // 事件：记账、轮边界、空闲续跑、会话删除
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
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
        try {
          await ctx.session.get({ sessionID })
          return true
        } catch (error) {
          return (error as { status?: number }).status === 404 ? false : true
        }
      },
      guardMs: options.reconcileGuardMinutes * 60_000,
      now: Date.now(),
    }).catch(() => undefined)

    return () => {
      abort.abort()
    }
  },
} satisfies Plugin.Plugin
