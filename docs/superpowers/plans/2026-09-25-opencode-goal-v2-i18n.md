# opencode-goal V2 国际化（i18n）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给插件的**面向用户文案**与**工具 schema**加上中英双语，默认跟随系统 locale，`language` 配置项可覆盖。

**Architecture:** 新增纯模块 `src/i18n/`（语言解析 + 消息目录 + `format`）；语言在 `server.ts` 的 `setup` 解析一次，得到的 `Messages` 经 `GoalDeps` 注入各 host 模块；`interface Messages` + `satisfies` 保证两语言键对齐。

**Tech Stack:** TypeScript（ESM，无构建，bun 直接加载 `.ts`）、Bun 1.4（`bun test`）、零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-25-opencode-goal-v2-i18n-design.md`

## Global Constraints

- **仅 OpenCode V2**；对宿主只做 `import type`；**零运行时依赖**（不新增 `dependencies`）。
- 源码内相对导入**不带扩展名**；`verbatimModuleSyntax` 开启（类型导入必须 `import type`）。
- `tsconfig` 有 `noUncheckedIndexedAccess`（数组/索引访问可能为 `undefined`）。
- 语言集**只有** `"zh-CN" | "en"`；语言在实例生命周期内**固定**，无运行时切换。
- **不本地化**：`prompts/index.ts` 的提示词、工具错误信息（`goal: ...`）、工具输出 `completionBudgetReport`、配置校验错误、`console.error` 日志。
- **提交信息用中文**。
- 每个任务结束必须：`bun test` 全绿 + `bunx tsc --noEmit` 无错 + 已提交。
- **热重载规避（重要）**：宿主监听插件导入图，改 `src/**` 会触发热重载。**开始实现前**先临时把插件从 `C:\Users\13178\.config\opencode\opencode.json` 的 `plugins` 移除（改为 `[]`），**全部任务完成后再复原**为 `["E:/Code/Projects/Agent/opencode-goal"]`，并确认 JSON 合法。此项由执行者在动手前完成，不单独设任务。

## File Structure

```
src/i18n/
  language.ts        新增  Language / toLanguage / systemLocale / resolveLanguage（纯）
  messages.ts        新增  interface Messages + MessageKey + format + statusLabel（纯）
  en.ts              新增  英文目录（默认）
  zh-CN.ts           新增  简体中文目录
  index.ts           新增  MESSAGES / messagesFor + 再导出
  language.test.ts   新增
  messages.test.ts   新增
src/config.ts        修改  Options.language + 校验
src/host/deps.ts     修改  GoalDeps.messages
src/host/commands.ts 修改  回执/状态行走 messages
src/host/continuation.ts 修改  续跑标签走 messages
src/host/notice.ts   修改  signalNotice 签名
src/host/events.ts   修改  signalNotice 调用 + 收窄
src/host/debug.ts    修改  调试输出走 messages
src/host/tools.ts    修改  goal 工具描述 + 参数说明走 messages
src/server.ts        修改  解析语言 + deps.messages + 命令/调试工具描述
```

任务边界：Task 1（语言+配置）、Task 2（目录，独立可测）、Task 3（接线：接口变更 + 命令/续跑 + 全部测试 helper）、Task 4（debug）、Task 5（signal 回执）、Task 6（goal 工具 schema）、Task 7（文档）。

---

### Task 1: 语言解析 + `language` 配置项

**Files:**
- Create: `src/i18n/language.ts`
- Create: `src/i18n/language.test.ts`
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  - `type Language = "zh-CN" | "en"`
  - `toLanguage(tag: string): Language | undefined`
  - `systemLocale(): string`
  - `resolveLanguage(explicit: Language | undefined, locale: string): Language`
  - `Options.language?: Language`（配置键 `language`）

- [ ] **Step 1: 写失败测试 `src/i18n/language.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { resolveLanguage, systemLocale, toLanguage } from "./language"

describe("toLanguage", () => {
  test("maps zh variants to zh-CN", () => {
    expect(toLanguage("zh")).toBe("zh-CN")
    expect(toLanguage("zh-CN")).toBe("zh-CN")
    expect(toLanguage("zh-Hans-CN")).toBe("zh-CN")
    expect(toLanguage("ZH_CN")).toBe("zh-CN")
  })

  test("maps en variants to en", () => {
    expect(toLanguage("en")).toBe("en")
    expect(toLanguage("en-US")).toBe("en")
    expect(toLanguage("EN")).toBe("en")
  })

  test("returns undefined for unsupported or empty tags", () => {
    expect(toLanguage("fr")).toBeUndefined()
    expect(toLanguage("C")).toBeUndefined()
    expect(toLanguage("")).toBeUndefined()
    expect(toLanguage("   ")).toBeUndefined()
  })
})

describe("resolveLanguage", () => {
  test("explicit wins over the system locale", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en")
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN")
  })

  test("falls back to the system locale", () => {
    expect(resolveLanguage(undefined, "zh-CN")).toBe("zh-CN")
    expect(resolveLanguage(undefined, "en-GB")).toBe("en")
  })

  test("falls back to en for an unsupported locale", () => {
    expect(resolveLanguage(undefined, "fr")).toBe("en")
    expect(resolveLanguage(undefined, "")).toBe("en")
  })
})

describe("systemLocale", () => {
  test("returns a non-empty string", () => {
    expect(typeof systemLocale()).toBe("string")
    expect(systemLocale().length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/i18n/language.test.ts`
Expected: FAIL（`Cannot find module './language'`）

- [ ] **Step 3: 实现 `src/i18n/language.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/i18n/language.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（追加到 `src/config.test.ts`）**

在 `src/config.test.ts` 的 `describe("resolveOptions", ...)` 内追加：

```ts
  test("language is optional and normalized", () => {
    expect(resolveOptions({}).language).toBeUndefined()
    expect(resolveOptions({ language: "zh" }).language).toBe("zh-CN")
    expect(resolveOptions({ language: "zh_CN" }).language).toBe("zh-CN")
    expect(resolveOptions({ language: "EN" }).language).toBe("en")
    expect("language" in DEFAULT_OPTIONS).toBe(false)
  })

  test("rejects a malformed language", () => {
    expect(() => resolveOptions({ language: "fr" })).toThrow(/language/)
    expect(() => resolveOptions({ language: 1 })).toThrow(/language/)
  })
```

- [ ] **Step 6: 运行测试确认失败**

Run: `bun test src/config.test.ts`
Expected: FAIL（`resolveOptions({ language: "zh" }).language` 为 `undefined`）

- [ ] **Step 7: 修改 `src/config.ts`**

顶部加导入：

```ts
import { toLanguage, type Language } from "./i18n/language"
```

`interface Options` 末尾（`debug` 之后）加一行：

```ts
  /** 面向用户文案的语言；缺省跟随系统 locale。 */
  readonly language?: Language
```

`resolveOptions` 的返回对象末尾（`debug: ...` 之后）加一行：

```ts
    language: languageValue(raw.language),
```

在文件底部（`nonEmptyString` 附近）新增：

```ts
function languageValue(value: unknown): Language | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`opencode-goal: option "language" must be "zh-CN" or "en"`)
  const language = toLanguage(value)
  if (language === undefined) throw new Error(`opencode-goal: option "language" must be "zh-CN" or "en"`)
  return language
}
```

> `DEFAULT_OPTIONS` **不要**加 `language`（缺省即跟随系统）。既有 `expect(resolveOptions({})).toEqual(DEFAULT_OPTIONS)` 仍成立（`toEqual` 忽略 `undefined` 属性）。

- [ ] **Step 8: 运行测试 + 类型检查**

Run: `bun test src/config.test.ts src/i18n/language.test.ts && bunx tsc --noEmit`
Expected: PASS，tsc 无输出

- [ ] **Step 9: 提交**

```bash
git add src/i18n/language.ts src/i18n/language.test.ts src/config.ts src/config.test.ts
git commit -m "feat(i18n): 语言解析（系统 locale 探测 + 显式覆盖）与 language 配置项"
```

---

### Task 2: 消息目录 + `format` / `statusLabel`

**Files:**
- Create: `src/i18n/messages.ts`
- Create: `src/i18n/en.ts`
- Create: `src/i18n/zh-CN.ts`
- Create: `src/i18n/index.ts`
- Create: `src/i18n/messages.test.ts`

**Interfaces:**
- Consumes: `Language`（`./language`）、`GoalStatus`（`../model/types`）
- Produces:
  - `interface Messages`（全部键见下）
  - `type MessageKey = keyof Messages`
  - `format(template: string, params: Record<string, string | number>): string`
  - `statusLabel(messages: Messages, status: GoalStatus): string`
  - `MESSAGES: Record<Language, Messages>`、`messagesFor(language: Language): Messages`

- [ ] **Step 1: 写失败测试 `src/i18n/messages.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import en from "./en"
import zhCN from "./zh-CN"
import { MESSAGES, format, messagesFor, statusLabel, type MessageKey } from "./index"

const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort()

describe("catalogs", () => {
  test("en and zh-CN have the same keys", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
  })

  test("no value is empty", () => {
    for (const value of Object.values(en)) expect(value.length).toBeGreaterThan(0)
    for (const value of Object.values(zhCN)) expect(value.length).toBeGreaterThan(0)
  })

  test("each key uses the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(zhCN[key])).toEqual(placeholders(en[key]))
    }
  })

  test("zh-CN differs from en for every key (no untranslated copy)", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(zhCN[key]).not.toBe(en[key])
    }
  })

  test("every template renders without leftover placeholders when all placeholders are supplied", () => {
    for (const catalog of [en, zhCN]) {
      for (const value of Object.values(catalog)) {
        const params = Object.fromEntries(placeholders(value).map((name) => [name, "x"]))
        expect(format(value, params)).not.toMatch(/\{[a-zA-Z]+\}/)
      }
    }
  })
})

describe("format", () => {
  test("replaces known placeholders", () => {
    expect(format("Goal is {status}; nothing to pause.", { status: "paused" })).toBe("Goal is paused; nothing to pause.")
  })

  test("leaves unknown placeholders intact", () => {
    expect(format("a {x} b", {})).toBe("a {x} b")
  })

  test("stringifies numbers", () => {
    expect(format("tokens {n}", { n: 160 })).toBe("tokens 160")
  })

  test("does not interpret $& or $1 in the substituted text", () => {
    expect(format("obj: {objective}", { objective: "a $& b $1" })).toBe("obj: a $& b $1")
  })
})

describe("statusLabel", () => {
  test("maps statuses per language", () => {
    expect(statusLabel(MESSAGES.en, "active")).toBe("active")
    expect(statusLabel(MESSAGES["zh-CN"], "active")).toBe("进行中")
    expect(statusLabel(MESSAGES["zh-CN"], "usage-limited")).toBe("用量受限")
  })
})

describe("messagesFor", () => {
  test("returns the catalog for a language", () => {
    expect(messagesFor("en")).toBe(en)
    expect(messagesFor("zh-CN")).toBe(zhCN)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/i18n/messages.test.ts`
Expected: FAIL（`Cannot find module './en'`）

- [ ] **Step 3: 实现 `src/i18n/messages.ts`**

```ts
import type { GoalStatus } from "../model/types"

/** 全部面向用户（TUI）文案 + 工具 schema 文案的键。两语言目录都必须满足本接口。 */
export interface Messages {
  readonly "cmd.goal": string
  readonly "cmd.status": string
  readonly "cmd.pause": string
  readonly "cmd.resume": string
  readonly "cmd.clear": string
  readonly "cmd.debug": string
  readonly "notice.noGoal": string
  readonly "notice.paused": string
  readonly "notice.resumed": string
  readonly "notice.cleared": string
  readonly "notice.nothingToPause": string
  readonly "notice.nothingToResume": string
  readonly "label.goalRequest": string
  readonly "label.autoContinue": string
  readonly "status.active": string
  readonly "status.paused": string
  readonly "status.blocked": string
  readonly "status.budget-limited": string
  readonly "status.usage-limited": string
  readonly "status.complete": string
  readonly "status.line": string
  readonly "status.budget": string
  readonly "status.noBudget": string
  readonly "status.detail": string
  readonly "status.lastError": string
  readonly "signal.usage-limited": string
  readonly "signal.budget-limited": string
  readonly "signal.detail": string
  readonly "signal.blocked": string
  readonly "debug.usage": string
  readonly "debug.env.header": string
  readonly "debug.env.instanceLocation": string
  readonly "debug.env.session": string
  readonly "debug.env.sessionDirectory": string
  readonly "debug.env.belongs": string
  readonly "debug.env.options": string
  readonly "debug.events.header": string
  readonly "debug.sessions.header": string
  readonly "debug.state.header": string
  readonly "debug.state.session": string
  readonly "debug.state.turnOpen": string
  readonly "debug.state.agent": string
  readonly "debug.state.directoryCache": string
  readonly "debug.state.pendingAutomatic": string
  readonly "debug.state.pendingBackground": string
  readonly "debug.state.blockedThisTurn": string
  readonly "debug.state.goal": string
  readonly "debug.unknownSubcommand": string
  readonly "debug.none": string
  readonly "debug.unknownValue": string
  readonly "debug.unknown": string
  readonly "debug.noTrackedState": string
  readonly "debug.yes": string
  readonly "debug.no": string
  readonly "tool.goal.description": string
  readonly "tool.goal.op": string
  readonly "tool.goal.objective": string
  readonly "tool.goal.tokenBudget": string
  readonly "tool.goal.blockerKey": string
  readonly "tool.goal.blocker": string
  readonly "tool.debug.description": string
  readonly "tool.debug.op": string
}

export type MessageKey = keyof Messages

/** 把 {name} 占位符替换为 params[name]；未提供的占位符原样保留（不抛）。 */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/** 用户可见的状态词（active → 进行中 / active）。 */
export function statusLabel(messages: Messages, status: GoalStatus): string {
  switch (status) {
    case "active":
      return messages["status.active"]
    case "paused":
      return messages["status.paused"]
    case "blocked":
      return messages["status.blocked"]
    case "budget-limited":
      return messages["status.budget-limited"]
    case "usage-limited":
      return messages["status.usage-limited"]
    case "complete":
      return messages["status.complete"]
  }
}
```

- [ ] **Step 4: 实现 `src/i18n/en.ts`**

```ts
import type { Messages } from "./messages"

/** 英文目录（默认语言）。 */
const en = {
  "cmd.goal": "Set a persistent goal for this session (empty reports the current goal).",
  "cmd.status": "Report the current goal.",
  "cmd.pause": "Pause the active goal.",
  "cmd.resume": "Resume a paused, blocked, budget-limited, or usage-limited goal.",
  "cmd.clear": "Clear the goal record.",
  "cmd.debug": "Read-only diagnostics for the goal plugin (no model turn).",
  "notice.noGoal": "No goal is set for this session.",
  "notice.paused": "Goal paused.",
  "notice.resumed": "Goal resumed.",
  "notice.cleared": "Goal cleared.",
  "notice.nothingToPause": "Goal is {status}; nothing to pause.",
  "notice.nothingToResume": "Goal is {status}; nothing to resume.",
  "label.goalRequest": "Goal request",
  "label.autoContinue": "Goal auto-continue",
  "status.active": "active",
  "status.paused": "paused",
  "status.blocked": "blocked",
  "status.budget-limited": "budget-limited",
  "status.usage-limited": "usage-limited",
  "status.complete": "complete",
  "status.line": "Goal ({status}) — tokens {tokens} / {budget}{detail}; {seconds}s{lastError}. Objective: {objective}",
  "status.budget": "budget {budget}",
  "status.noBudget": "no budget",
  "status.detail": " (cacheRead {cacheRead} · new work {newWork})",
  "status.lastError": "; last error: {error}",
  "signal.usage-limited": "Goal marked usage-limited{detail}. Use /goal-resume after the limit resets.",
  "signal.budget-limited": "Goal marked budget-limited{detail}. Use /goal-resume to continue.",
  "signal.detail": ": {message}",
  "signal.blocked": "Goal marked blocked{detail}. Use /goal-resume after resolving it.",
  "debug.usage": "{pluginId} debug — usage: env | events | sessions | state",
  "debug.env.header": "{pluginId} debug env",
  "debug.env.instanceLocation": "instance location: {dir}",
  "debug.env.session": "session: {id}",
  "debug.env.sessionDirectory": "session directory: {dir}",
  "debug.env.belongs": "belongs to this instance: {verdict}",
  "debug.env.options": "options: {json}",
  "debug.events.header": "{pluginId} debug events (last {n})",
  "debug.sessions.header": "{pluginId} debug sessions ({n})",
  "debug.state.header": "{pluginId} debug state",
  "debug.state.session": "session: {id}",
  "debug.state.turnOpen": "turn open: {value}",
  "debug.state.agent": "agent: {agent}",
  "debug.state.directoryCache": "session directory cache: {dir}",
  "debug.state.pendingAutomatic": "pending automatic: {value}",
  "debug.state.pendingBackground": "pending background: {value}",
  "debug.state.blockedThisTurn": "blocked this turn: {value}",
  "debug.state.goal": "goal: {goal}",
  "debug.unknownSubcommand": "Unknown debug subcommand: {op}\n{usage}",
  "debug.none": "(none)",
  "debug.unknownValue": "(unknown)",
  "debug.unknown": "unknown",
  "debug.noTrackedState": "(no tracked state)",
  "debug.yes": "yes",
  "debug.no": "no",
  "tool.goal.description": 'Manage the persistent goal for this session. op "create" starts a goal only when explicitly requested; "get" reports it; "complete" asserts evidence-backed completion; "resume"/"drop" are also available; "block" reports a recurring blocker.',
  "tool.goal.op": "Operation: create | get | complete | resume | drop | block.",
  "tool.goal.objective": 'Objective text for op "create".',
  "tool.goal.tokenBudget": 'Optional token budget for op "create".',
  "tool.goal.blockerKey": 'Stable blocker key for op "block".',
  "tool.goal.blocker": 'Short blocker description for op "block".',
  "tool.debug.description": "DEBUG ONLY — read-only diagnostics for the opencode-goal plugin (which location owns this session, recent event-ownership decisions, stored goals, in-memory turn state). Do NOT call this during normal goal work. Call it only when the user explicitly asks to debug the goal plugin, or when goal auto-continuation misbehaves.",
  "tool.debug.op": "Which diagnostic to render (debug-only; never call speculatively).",
} satisfies Messages

export default en
```

- [ ] **Step 5: 实现 `src/i18n/zh-CN.ts`**

```ts
import type { Messages } from "./messages"

/** 简体中文目录。 */
const zhCN = {
  "cmd.goal": "为本会话设置持久目标（留空则报告当前目标）。",
  "cmd.status": "报告当前目标。",
  "cmd.pause": "暂停当前进行中的目标。",
  "cmd.resume": "恢复已暂停、受阻、预算用尽或用量受限的目标。",
  "cmd.clear": "清除目标记录。",
  "cmd.debug": "goal 插件的只读诊断（不触发模型轮）。",
  "notice.noGoal": "本会话未设置目标。",
  "notice.paused": "目标已暂停。",
  "notice.resumed": "目标已恢复。",
  "notice.cleared": "目标已清除。",
  "notice.nothingToPause": "目标当前为「{status}」，无需暂停。",
  "notice.nothingToResume": "目标当前为「{status}」，无需恢复。",
  "label.goalRequest": "目标请求",
  "label.autoContinue": "目标自动续跑",
  "status.active": "进行中",
  "status.paused": "已暂停",
  "status.blocked": "已受阻",
  "status.budget-limited": "预算用尽",
  "status.usage-limited": "用量受限",
  "status.complete": "已完成",
  "status.line": "目标（{status}）— tokens {tokens} / {budget}{detail}；{seconds}s{lastError}。目标：{objective}",
  "status.budget": "预算 {budget}",
  "status.noBudget": "无预算",
  "status.detail": "（cacheRead {cacheRead} · 新增 {newWork}）",
  "status.lastError": "；最近错误：{error}",
  "signal.usage-limited": "目标已标记为用量受限{detail}。配额恢复后可用 /goal-resume 继续。",
  "signal.budget-limited": "目标已标记为预算用尽{detail}。可用 /goal-resume 继续。",
  "signal.detail": "：{message}",
  "signal.blocked": "目标已标记为受阻{detail}。解决后可用 /goal-resume 继续。",
  "debug.usage": "{pluginId} 调试 — 用法：env | events | sessions | state",
  "debug.env.header": "{pluginId} 调试 env",
  "debug.env.instanceLocation": "实例 location：{dir}",
  "debug.env.session": "会话：{id}",
  "debug.env.sessionDirectory": "会话目录：{dir}",
  "debug.env.belongs": "是否属于本实例：{verdict}",
  "debug.env.options": "配置：{json}",
  "debug.events.header": "{pluginId} 调试事件（最近 {n} 条）",
  "debug.sessions.header": "{pluginId} 调试目标记录（{n} 条）",
  "debug.state.header": "{pluginId} 调试 state",
  "debug.state.session": "会话：{id}",
  "debug.state.turnOpen": "轮进行中：{value}",
  "debug.state.agent": "agent：{agent}",
  "debug.state.directoryCache": "会话目录缓存：{dir}",
  "debug.state.pendingAutomatic": "待自动续跑：{value}",
  "debug.state.pendingBackground": "待后台唤醒：{value}",
  "debug.state.blockedThisTurn": "本轮已受阻：{value}",
  "debug.state.goal": "目标：{goal}",
  "debug.unknownSubcommand": "未知的调试子命令：{op}\n{usage}",
  "debug.none": "（无）",
  "debug.unknownValue": "（未知）",
  "debug.unknown": "未知",
  "debug.noTrackedState": "（无跟踪状态）",
  "debug.yes": "是",
  "debug.no": "否",
  "tool.goal.description": "管理本会话的持久目标。op \"create\" 仅在用户明确要求时启动目标；\"get\" 报告目标；\"complete\" 在证据充分时声明完成；另有 \"resume\"/\"drop\"；\"block\" 上报反复出现的阻碍。",
  "tool.goal.op": "操作：create | get | complete | resume | drop | block。",
  "tool.goal.objective": "目标正文（op \"create\" 时使用）。",
  "tool.goal.tokenBudget": "可选 token 预算（op \"create\" 时使用）。",
  "tool.goal.blockerKey": "稳定的 blocker 键（op \"block\" 时使用）。",
  "tool.goal.blocker": "简短的 blocker 描述（op \"block\" 时使用）。",
  "tool.debug.description": "仅调试用——opencode-goal 插件的只读诊断（本会话归属哪个 location、最近的事件归属判定、已存目标、内存中的轮状态）。正常目标工作期间不要调用；仅当用户明确要求调试该插件、或目标自动续跑行为异常时调用。",
  "tool.debug.op": "要渲染哪项诊断（仅调试用；不要凭空调用）。",
} satisfies Messages

export default zhCN
```

- [ ] **Step 6: 实现 `src/i18n/index.ts`**

```ts
import type { Language } from "./language"
import type { Messages } from "./messages"
import en from "./en"
import zhCN from "./zh-CN"

export const MESSAGES: Record<Language, Messages> = {
  en,
  "zh-CN": zhCN,
}

export function messagesFor(language: Language): Messages {
  return MESSAGES[language]
}

export type { Language } from "./language"
export type { Messages, MessageKey } from "./messages"
export { format, statusLabel } from "./messages"
export { resolveLanguage, systemLocale, toLanguage } from "./language"
```

- [ ] **Step 7: 运行测试 + 类型检查**

Run: `bun test src/i18n/messages.test.ts && bunx tsc --noEmit`
Expected: PASS，tsc 无输出

- [ ] **Step 8: 提交**

```bash
git add src/i18n/messages.ts src/i18n/en.ts src/i18n/zh-CN.ts src/i18n/index.ts src/i18n/messages.test.ts
git commit -m "feat(i18n): 中英消息目录 + format/statusLabel（键与占位符对齐）"
```

---

### Task 3: 接线 —— `GoalDeps.messages` + server/命令/续跑 + 全部测试 helper

**Files:**
- Modify: `src/host/deps.ts`
- Modify: `src/server.ts`
- Modify: `src/host/commands.ts`
- Modify: `src/host/continuation.ts`
- Modify（测试 helper）: `src/host/commands.test.ts`、`src/host/continuation.test.ts`、`src/host/debug.test.ts`、`src/host/events.test.ts`、`src/host/hooks.test.ts`、`src/host/tools.test.ts`、`src/server.test.ts`

**Interfaces:**
- Consumes: `messagesFor`（`../i18n`）、`format` / `statusLabel` / `Messages`（`../i18n/messages`）、`resolveLanguage` / `systemLocale`（`../i18n/language`）
- Produces: `GoalDeps.messages: Messages`（必填）

- [ ] **Step 1: 写失败测试（中文回执）**

在 `src/host/commands.test.ts` 顶部加 `import { messagesFor } from "../i18n"`，并在 `describe("createCommandHandlers", ...)` 内追加：

```ts
  test("notices follow the injected language", async () => {
    const deps = { ...makeDeps(), messages: messagesFor("zh-CN") }
    const { handlers, notices } = runner(deps)
    await handlers.status("ses_1")
    expect(notices[0]).toBe("本会话未设置目标。")
  })

  test("a rendered status line leaves no placeholders", async () => {
    const { deps, handlers, notices } = makeHandler()
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0, tokenBudget: 100 }))
    await handlers.status("ses_1")
    expect(notices[0]).not.toMatch(/\{[a-zA-Z]+\}/)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/host/commands.test.ts`
Expected: FAIL（`notices[0]` 仍是英文 `No goal is set for this session.`）

- [ ] **Step 3: 修改 `src/host/deps.ts`**

顶部加导入：

```ts
import type { Messages } from "../i18n/messages"
```

`interface GoalDeps` 内加一行（放在 `options` 之后）：

```ts
  /** 面向用户文案（语言在 setup 时确定）。 */
  readonly messages: Messages
```

- [ ] **Step 4: 修改 `src/host/commands.ts`**

顶部加导入：

```ts
import { format, statusLabel, type Messages } from "../i18n/messages"
```

把 `status` 处理里的回执改为：

```ts
  const status = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    await port.notify(
      sessionID,
      existing
        ? statusLine(withPending(existing, deps.pendingUsage?.(sessionID)), deps.messages)
        : deps.messages["notice.noGoal"],
    )
  }
```

`pause` / `resume` / `clear` 的回执替换为：

```ts
  const pause = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    if (existing.status !== "active")
      return port.notify(
        sessionID,
        format(deps.messages["notice.nothingToPause"], { status: statusLabel(deps.messages, existing.status) }),
      )
    await deps.repo.save(sessionID, pauseGoal(existing, deps.now()))
    return port.notify(sessionID, deps.messages["notice.paused"])
  }

  const resume = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    let resumed: Goal
    try {
      resumed = resumeGoal(existing, deps.now())
    } catch {
      return port.notify(
        sessionID,
        format(deps.messages["notice.nothingToResume"], { status: statusLabel(deps.messages, existing.status) }),
      )
    }
    await deps.repo.save(sessionID, resumed)
    return port.notify(sessionID, deps.messages["notice.resumed"])
  }

  const clear = async (sessionID: string): Promise<void> => {
    const existing = await deps.repo.load(sessionID)
    if (!existing) return port.notify(sessionID, deps.messages["notice.noGoal"])
    await deps.repo.remove(sessionID)
    return port.notify(sessionID, deps.messages["notice.cleared"])
  }
```

`goal` 处理里的 `description` 改为：

```ts
        description: noticeLine(deps.messages["label.goalRequest"], parsed.objective ?? ""),
```

`statusLine` 函数替换为：

```ts
function statusLine(goal: Goal, messages: Messages): string {
  const budget =
    goal.tokenBudget === undefined
      ? messages["status.noBudget"]
      : format(messages["status.budget"], { budget: goal.tokenBudget })
  // 分项只在「和 == tokensUsed」时展示（旧记录升级后不满足 → 只给总量）。
  const usage = goal.usage && usageIsComplete(goal) ? goal.usage : undefined
  const detail = usage
    ? format(messages["status.detail"], { cacheRead: usage.cacheRead, newWork: newWorkOf(usage) })
    : ""
  const lastError = goal.lastError
    ? format(messages["status.lastError"], { error: goal.lastError.message || goal.lastError.type })
    : ""
  return format(messages["status.line"], {
    status: statusLabel(messages, goal.status),
    tokens: goal.tokensUsed,
    budget,
    detail,
    seconds: goal.timeUsedSeconds,
    lastError,
    objective: goal.objective,
  })
}
```

- [ ] **Step 5: 修改 `src/host/continuation.ts`**

把 `description: noticeLine("Goal auto-continue", goal.objective)` 改为：

```ts
        description: noticeLine(deps.messages["label.autoContinue"], goal.objective),
```

- [ ] **Step 6: 修改 `src/server.ts`**

顶部加导入：

```ts
import { messagesFor, resolveLanguage, systemLocale } from "./i18n"
```

在 `const options = resolveOptions(ctx.options)` 之后加：

```ts
    const language = resolveLanguage(options.language, systemLocale())
    const messages = messagesFor(language)
```

`deps` 对象内加 `messages,`（放在 `options,` 之后）。

命令描述替换（`editor.add` 各处）：

```ts
        description: messages["cmd.goal"],     // /goal
        description: messages["cmd.status"],   // /goal-status
        description: messages["cmd.pause"],    // /goal-pause
        description: messages["cmd.resume"],   // /goal-resume
        description: messages["cmd.clear"],    // /goal-clear
        description: messages["cmd.debug"],    // /goal-debug
```

`goal_debug` 工具描述与 `op` 说明替换：

```ts
          description: messages["tool.debug.description"],
```

```ts
                description: messages["tool.debug.op"],
```

- [ ] **Step 7: 更新全部测试 helper**

在下列文件的 `makeDeps()` 返回对象里加 `messages: messagesFor("en"),`（与 `options` 同级），并在文件顶部加 `import { messagesFor } from "../i18n"`：

- `src/host/commands.test.ts`（`makeDeps`，约 58-68 行）
- `src/host/continuation.test.ts`（`makeDeps`，约 26-37 行）
- `src/host/debug.test.ts`（`makeDeps`，约 29-39 行）
- `src/host/events.test.ts`（`makeDeps`，约 29-39 行）
- `src/host/hooks.test.ts`（`makeDeps`，约 26-36 行）
- `src/host/tools.test.ts`（`makeDeps`，约 26-38 行）

`src/server.test.ts`：把 `mockCtx` 里的 `options: {},` 改为 `options: { language: "en" },`（走 `setup` 的测试不得依赖机器 locale）。

- [ ] **Step 8: 运行测试 + 类型检查**

Run: `bun test && bunx tsc --noEmit`
Expected: 全绿，tsc 无输出

- [ ] **Step 9: 提交**

```bash
git add src/host/deps.ts src/server.ts src/host/commands.ts src/host/continuation.ts src/host/commands.test.ts src/host/continuation.test.ts src/host/debug.test.ts src/host/events.test.ts src/host/hooks.test.ts src/host/tools.test.ts src/server.test.ts
git commit -m "feat(i18n): 语言经 GoalDeps 注入，命令/续跑/命令描述本地化"
```

---

### Task 4: 调试输出本地化（`debug.ts`）

**Files:**
- Modify: `src/host/debug.ts`
- Test: `src/host/debug.test.ts`

**Interfaces:**
- Consumes: `format` / `Messages`（`../i18n/messages`）、`GoalDeps.messages`

- [ ] **Step 1: 追加中文用例到 `src/host/debug.test.ts`**

在 `describe("createDebug", ...)` 内追加：

```ts
  test("output follows the injected language", async () => {
    const deps = { ...makeDeps(), messages: messagesFor("zh-CN") }
    const { debug } = makeDebug(deps)
    const text = await debug.render("env", "ses_1")
    expect(text).toContain("是否属于本实例：是")
    expect(text).toContain("会话：ses_1")
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/)
  })
```

（文件顶部已有 `messagesFor` 导入，来自 Task 3。）

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/host/debug.test.ts`
Expected: FAIL（输出仍是英文）

- [ ] **Step 3: 重写 `src/host/debug.ts`**

完整替换为：

```ts
import { format, type Messages } from "../i18n/messages"
import type { GoalDeps } from "./deps"
import type { DebugEventRecord, DebugSnapshot } from "./events"

/** 调试专用的只读视图（由 events 路由提供）。 */
export interface DebugSource {
  readonly pluginId: string
  readonly snapshot: () => DebugSnapshot
}

export interface Debug {
  /** 渲染一次诊断输出（**纯文本**）；空 op 或未知 op 返回用法。 */
  render(op: string, sessionID: string): Promise<string>
}

export const DEBUG_OPS = ["env", "events", "sessions", "state"] as const

/**
 * 注意：这些文本最终走 `session.synthetic` 的 `description`，而 TUI 的 notice 行是
 * **纯文本渲染、不解析 Markdown**（`###`、`| 表格 |` 会原样显示，很难看）。
 * 所以这里一律输出裸文本，不要用 Markdown 语法。
 */
function usage(messages: Messages, pluginId: string): string {
  return format(messages["debug.usage"], { pluginId })
}

function block(header: string, rows: readonly string[], messages: Messages): string {
  return [header, ...(rows.length === 0 ? [messages["debug.none"]] : rows)].join("\n")
}

function short(id: string, length = 16): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** 本地墙钟时间 `HH:mm:ss.SSS`（调试输出给人看，用本地时区而非 UTC）。 */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

async function renderEnv(deps: GoalDeps, source: DebugSource, sessionID: string): Promise<string> {
  const messages = deps.messages
  const directory = await deps.sessionDirectory(sessionID)
  const verdict =
    directory === undefined
      ? messages["debug.unknown"]
      : directory === deps.locationDirectory
        ? messages["debug.yes"]
        : messages["debug.no"]
  return block(
    format(messages["debug.env.header"], { pluginId: source.pluginId }),
    [
      format(messages["debug.env.instanceLocation"], { dir: deps.locationDirectory }),
      format(messages["debug.env.session"], { id: sessionID }),
      format(messages["debug.env.sessionDirectory"], { dir: directory ?? messages["debug.unknownValue"] }),
      format(messages["debug.env.belongs"], { verdict }),
      format(messages["debug.env.options"], { json: JSON.stringify(deps.options) }),
    ],
    messages,
  )
}

function renderEvents(pluginId: string, messages: Messages, events: readonly DebugEventRecord[]): string {
  const rows = events.map((event) =>
    [
      clock(event.at),
      event.type,
      event.sessionID === undefined ? "-" : short(event.sessionID),
      event.hasLocation ? short(event.location ?? "", 28) : "-",
      event.decision,
    ].join("  "),
  )
  return block(format(messages["debug.events.header"], { pluginId, n: events.length }), rows, messages)
}

async function renderSessions(deps: GoalDeps, pluginId: string): Promise<string> {
  const messages = deps.messages
  const all = await deps.repo.listAll()
  const rows = all.map(({ sessionID, goal }) =>
    [short(sessionID), goal.status, clip(goal.objective, 60), clock(goal.updatedAt)].join("  "),
  )
  return block(format(messages["debug.sessions.header"], { pluginId, n: all.length }), rows, messages)
}

async function renderState(
  deps: GoalDeps,
  pluginId: string,
  sessionID: string,
  snapshot: DebugSnapshot,
): Promise<string> {
  const messages = deps.messages
  const state = snapshot.sessions.find((item) => item.sessionID === sessionID)
  const goal = await deps.repo.load(sessionID)
  const cache = state?.sessionDirectory
  return block(
    format(messages["debug.state.header"], { pluginId }),
    [
      format(messages["debug.state.session"], { id: sessionID }),
      format(messages["debug.state.turnOpen"], {
        value: state === undefined ? messages["debug.noTrackedState"] : String(state.turnOpen),
      }),
      format(messages["debug.state.agent"], { agent: state?.agent ?? messages["debug.unknown"] }),
      format(messages["debug.state.directoryCache"], {
        dir: cache === undefined || cache === null ? messages["debug.none"] : cache,
      }),
      format(messages["debug.state.pendingAutomatic"], {
        value: state === undefined ? "-" : String(state.pendingAutomatic),
      }),
      format(messages["debug.state.pendingBackground"], { value: state === undefined ? "-" : state.pendingBackground }),
      format(messages["debug.state.blockedThisTurn"], {
        value: state === undefined ? "-" : String(state.blockedThisTurn),
      }),
      format(messages["debug.state.goal"], {
        goal:
          goal === undefined
            ? messages["debug.none"]
            : `${goal.status}, emptyStreak=${goal.emptyStreak}, blockerStreak=${goal.blockerStreak}`,
      }),
    ],
    messages,
  )
}

/**
 * `/goal-debug` 的确定性入口：零 token、只读、不产生任何副作用。
 * 输出保持**短**且为纯文本：命令的唯一出口是往会话插一条消息，会留在历史里。
 */
export function createDebug(deps: GoalDeps, source: DebugSource): Debug {
  return {
    async render(rawOp, sessionID) {
      const messages = deps.messages
      const op = rawOp.trim().toLowerCase()
      switch (op) {
        case "":
        case "help":
          return usage(messages, source.pluginId)
        case "env":
          return renderEnv(deps, source, sessionID)
        case "events":
          return renderEvents(source.pluginId, messages, source.snapshot().events)
        case "sessions":
          return renderSessions(deps, source.pluginId)
        case "state":
          return renderState(deps, source.pluginId, sessionID, source.snapshot())
        default:
          return format(messages["debug.unknownSubcommand"], { op, usage: usage(messages, source.pluginId) })
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `bun test src/host/debug.test.ts && bunx tsc --noEmit`
Expected: PASS（英文断言保持通过，中文用例通过）

- [ ] **Step 5: 提交**

```bash
git add src/host/debug.ts src/host/debug.test.ts
git commit -m "feat(i18n): /goal-debug 输出本地化"
```

---

### Task 5: 宿主信号回执本地化（`notice.ts` + `events.ts`）

**Files:**
- Modify: `src/host/notice.ts`
- Modify: `src/host/events.ts`
- Test: `src/host/events.test.ts`

**Interfaces:**
- Consumes: `format` / `Messages`（`../i18n/messages`）
- Produces: `signalNotice(messages: Messages, status: "usage-limited" | "budget-limited" | "blocked", message: string): string`

- [ ] **Step 1: 追加中文用例到 `src/host/events.test.ts`**

在 `describe` 内、`"a quota failure with an empty message omits the detail clause"` 之后追加：

```ts
  test("a quota failure notice follows the injected language", async () => {
    const deps = { ...makeDeps(), messages: messagesFor("zh-CN") }
    await deps.repo.save("ses_1", createGoal({ goalId: "g1", objective: "o", now: 0 }))
    const notices: string[] = []
    const router = makeRouter(deps, { onIdle: async () => false }, notices)
    await router.handle(executionStarted("ses_1"))
    await router.handle(executionFailedWithError("ses_1", { type: "provider.quota", message: "weekly usage limit" }))
    expect(notices[0]).toBe("目标已标记为用量受限：weekly usage limit。配额恢复后可用 /goal-resume 继续。")
    expect(notices[0]).not.toMatch(/\{[a-zA-Z]+\}/)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/host/events.test.ts`
Expected: FAIL（回执仍是英文）

- [ ] **Step 3: 修改 `src/host/notice.ts`**

顶部把导入换成下面这行，并**只替换 `signalNotice`**（`noticeLine` 原样保留）：

```ts
import { format, type Messages } from "../i18n/messages"

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
```

（`noticeLine` 保持语言无关，不改；`signalNotice` 用字面量联合后不再需要 `GoalStatus` 导入。）

- [ ] **Step 4: 修改 `src/host/events.ts` 的调用点**

把（约 405 行）：

```ts
          if (after && after.status !== before.status) await notify(sessionID, signalNotice(after.status, signal.message))
```

改为：

```ts
          const next = after?.status
          if (
            after &&
            next !== before.status &&
            (next === "usage-limited" || next === "budget-limited" || next === "blocked")
          )
            await notify(sessionID, signalNotice(deps.messages, next, signal.message))
```

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `bun test src/host/events.test.ts && bunx tsc --noEmit`
Expected: PASS，tsc 无输出

- [ ] **Step 6: 提交**

```bash
git add src/host/notice.ts src/host/events.ts src/host/events.test.ts
git commit -m "feat(i18n): 宿主信号回执本地化（signalNotice 收 messages + 状态收窄）"
```

---

### Task 6: `goal` 工具 schema 本地化（`tools.ts`）

**Files:**
- Modify: `src/host/tools.ts`
- Test: `src/host/tools.test.ts`

**Interfaces:**
- Consumes: `Messages`（`../i18n/messages`）、`GoalDeps.messages`
- Produces: `goalToolInput` 由常量改为**函数** `goalToolInput(messages: Messages): any`（仅本文件内部使用）

- [ ] **Step 1: 追加用例到 `src/host/tools.test.ts`**

在 `describe("createGoalTool", ...)` 内追加：

```ts
  test("tool description and parameter descriptions follow the language", () => {
    const en = createGoalTool(makeDeps())
    const zh = createGoalTool({ ...makeDeps(), messages: messagesFor("zh-CN") })
    expect(en.description).toContain("persistent goal")
    expect(zh.description).toContain("持久目标")
    expect(zh.input.properties.op.description).toContain("操作")
    expect(zh.input.properties.objective.description).toContain("目标正文")
  })
```

（文件顶部已有 `messagesFor` 导入，来自 Task 3。）

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/host/tools.test.ts`
Expected: FAIL（`zh.input.properties.op` 为 `undefined`，且描述仍是英文）

- [ ] **Step 3: 修改 `src/host/tools.ts`**

顶部加导入：

```ts
import type { Messages } from "../i18n/messages"
```

把 `export const goalToolInput: any = { ... }` 替换为函数：

```ts
/** 宿主按 JSON Schema 解析；用 any 避免与 effect 的 JsonSchema 类型耦合。 */
export function goalToolInput(messages: Messages): any {
  return {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["create", "get", "complete", "resume", "drop", "block"],
        description: messages["tool.goal.op"],
      },
      objective: { type: "string", description: messages["tool.goal.objective"] },
      token_budget: { type: "integer", minimum: 1, description: messages["tool.goal.tokenBudget"] },
      blocker_key: { type: "string", description: messages["tool.goal.blockerKey"] },
      blocker: { type: "string", description: messages["tool.goal.blocker"] },
    },
    required: ["op"],
    additionalProperties: false,
  }
}
```

`createGoalTool` 返回对象里：

```ts
    description: deps.messages["tool.goal.description"],
    input: goalToolInput(deps.messages),
```

- [ ] **Step 4: 运行测试 + 类型检查**

Run: `bun test src/host/tools.test.ts && bunx tsc --noEmit`
Expected: PASS，tsc 无输出

- [ ] **Step 5: 提交**

```bash
git add src/host/tools.ts src/host/tools.test.ts
git commit -m "feat(i18n): goal 工具描述与参数说明本地化"
```

---

### Task 7: 文档回填

**Files:**
- Modify: `README.md`（配置项表）
- Modify: `CHANGELOG.md`（`[Unreleased]`）
- Modify: `docs/opencode/known-issues.md`（V2 待办段，新增状态说明）
- Modify: `docs/superpowers/specs/2026-09-25-opencode-goal-v2-i18n-design.md`（状态改为已实现）

> `docs/opencode/config-install.md` **不改**：它是安装机制资料，没有本插件的选项表/列表；选项以 README 的「配置项」表为准。

- [ ] **Step 1: `README.md` 配置项表加一行**

在 `| debug | true | ... |` 之后加：

```markdown
| `language` | 跟随系统 | 面向用户文案的语言，`"zh-CN"` 或 `"en"`（缺省用系统 locale 探测） |
```

- [ ] **Step 2: `CHANGELOG.md` 的 `[Unreleased]` → `### Added` 末尾加一条**

```markdown
- **国际化（i18n）**：面向用户文案（命令描述、`/goal-*` 回执、状态行、宿主信号回执、`/goal-debug` 输出）与 `goal` 工具描述/参数说明支持中英双语；语言默认跟随系统 locale（`Intl` 探测），可用配置项 `language` 显式覆盖。模型提示词与日志保持英文。
```

- [ ] **Step 3: `docs/opencode/known-issues.md` 的 V2 待办段新增一条状态说明**

在「宿主信号 → 状态」条目之后加：

```markdown
> 「国际化（i18n）」已于 V2 实现（见 `CHANGELOG.md` 的 `[Unreleased]`）。默认跟随系统 locale，可用 `language` 覆盖。
```

- [ ] **Step 4: 把 spec 状态改为已实现**

`docs/superpowers/specs/2026-09-25-opencode-goal-v2-i18n-design.md` 顶部状态行改为：

```markdown
- 状态：**已实现（2026-09-25）**
```

- [ ] **Step 5: 提交**

```bash
git add README.md CHANGELOG.md docs/opencode/known-issues.md docs/superpowers/specs/2026-09-25-opencode-goal-v2-i18n-design.md
git commit -m "docs: 回填 i18n（README/CHANGELOG/known-issues/spec）"
```

---

### Task 8: 复原插件配置 + 真机核对

**Files:** 无（环境操作）

- [ ] **Step 1: 复原 `~/.config/opencode/opencode.json` 的 plugins**

先读取该文件确认**当前/原始形态**（本机此前为字符串形式 `["E:/Code/Projects/Agent/opencode-goal"]`），按原样恢复：

```json
  "plugins": ["E:/Code/Projects/Agent/opencode-goal"]
```

校验 JSON：`node -e "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE + '/.config/opencode/opencode.json','utf8')); console.log('config OK')"`

- [ ] **Step 2: 真机核对**

在本机 TUI 的冒烟会话里执行 `/goal-status`：应显示**中文**回执（本机系统 locale = `zh-CN`）。
再执行 `/goal-debug env`：输出应为中文标签。

- [ ] **Step 3: 记录结果**

把结果追加到 `docs/opencode/smoke-checklist.md`（新开 `## 9. i18n 真机验收` 段），提交：

```bash
git add docs/opencode/smoke-checklist.md
git commit -m "docs(smoke): 记录 i18n 真机验收（系统 locale 跟随 + 中文回执）"
```
