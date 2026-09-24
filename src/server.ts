import type { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./config"
import { createCommandHandler } from "./host/commands"
import { createContinuation } from "./host/continuation"
import type { GoalDeps } from "./host/deps"
import { createEventRouter, type EventLike } from "./host/events"
import { createCompactionHook, createContextHook } from "./host/hooks"
import { isRestrictedAgent } from "./host/plan"
import { createGoalTool } from "./host/tools"
import { createTurnTracker } from "./host/turn"
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
    }

    // 命令：保留名服务端确定性处理；其余转发给模型。
    ctx.command.transform((editor) => {
      editor.add({
        name: options.commandName,
        description: "Set, inspect, pause, resume, or clear the persistent goal.",
        execute: async (input) => {
          const handler = createCommandHandler(deps, {
            prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }).then(() => undefined),
            notify: (sessionID, text) => ctx.session.synthetic({ sessionID, text }).then(() => undefined),
          })
          await handler({ sessionID: input.sessionID, prompt: { text: input.prompt.text } })
        },
      })
    })

    // 工具：goal(op=...)
    ctx.tool.transform((editor) => {
      const tool = createGoalTool(deps)
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        execute: async (input, context) => tool.execute(input, context),
      })
    })

    // 钩子：常态轻量提醒 + 压缩快照
    ctx.session.hook("context", createContextHook(deps))
    ctx.session.hook("compaction", createCompactionHook(deps))

    // 事件：记账、轮边界、空闲续跑、会话删除
    const abort = new AbortController()
    const tracker = createTurnTracker()
    const continuation = createContinuation(deps, {
      prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }).then(() => undefined),
    })
    const router = createEventRouter(deps, tracker, continuation)
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          await router.handle(event as unknown as EventLike)
        }
      } catch {
        // 订阅中断/出错不致命
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
