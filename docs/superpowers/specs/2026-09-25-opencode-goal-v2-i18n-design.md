# opencode-goal V2 子项目设计：国际化（i18n）

- 日期：2026-09-25
- 状态：**已实现（2026-09-25）**
- 宿主：**OpenCode V2**（分支 `v2`，`@opencode/plugin@2.0.16`；宿主源码检出 `../Externals/opencode`）
- 上级：V2 里程碑。**说明**：早先文档把 i18n 列为「已砍」，本设计将其**恢复为独立子项目并优先实现**（用户决定）。
- 相关：`docs/superpowers/specs/2026-09-24-opencode-goal-design.md`（v1，§1 非目标提到 i18n）、`docs/01-design-orientation.md` §4/§7、`docs/opencode/config-install.md`、`docs/opencode/known-issues.md`

## 1. 背景与问题

插件的**面向用户文案**（命令描述、`/goal-*` 回执、宿主信号回执、`/goal-debug` 输出）目前**绝大多数是英文硬编码**（`/goal-debug` 的用法行已是中英混排，属历史遗留）。中文用户（本插件的主要使用者）在 TUI 里读到的回执如 `Goal marked blocked: Invalid or missing API key. Use /goal-resume after resolving it.`，需要自行翻译才能理解插件做了什么。

v1 设计把 i18n 列为非目标（「英文模板 + 模型跟随用户语言」），但那只覆盖**发给模型的提示词**；**给人看的回执**并没有任何语言策略。本子项目补上这一层。

### 1.1 宿主不提供语言

已核实：`@opencode/plugin` 的 `Plugin.Context` **没有** locale / language 字段（`packages/plugin/src/**` 无相关导出），宿主也不把语言传给插件。因此语言只能由**插件自己决定**。

### 1.2 系统语言可探测

插件跑在 Bun 里，可用 `Intl.DateTimeFormat().resolvedOptions().locale` 拿到系统 locale（走 ICU，与宿主进程无关）。本机实测（Windows，中文区域）返回 `zh-CN`。环境变量 `LANG`/`LC_ALL`/`LC_MESSAGES` 在本机**未设置**，不能依赖。

**结论**：默认**自动跟随系统 locale**，另留配置项 `language` 作显式覆盖。

## 2. 目标与非目标

**目标**：

- 新增语言层：`Language = "zh-CN" | "en"`；默认由系统 locale 探测（`zh*` → `zh-CN`，其余 → `en`，兜底 `en`）；配置项 `language` 可显式覆盖。
- 用**每语言一个 TS 模块 + 键值字典**（`Record` 形状，值为带 `{占位符}` 的字符串）+ `format()` 插值承载文案；`tsc` 保证两语言键集合一致。
- 本地化**全部面向用户文案**（清单见 §5）：命令描述、命令回执、状态行与状态词、宿主信号回执、`/goal-debug` 输出、以及 **`goal` 工具的描述与参数说明**。

**非目标（本子项目不做）**：

- **不本地化发给模型的提示词**（`prompts/index.ts` 的 `goalContext` / `continuationTrigger` / `compactionSnapshot` / `budgetLimitPrompt` / `goalCommandPrompt` / `blockedWrapUp`）——沿用 v1「英文模板 + 模型跟随用户语言」。
- **不本地化工具错误信息**（`tools.ts` 里 `goal: ...` 的 `throw`）与**工具输出**里的 `completionBudgetReport`（都是模型读的）。
- 不做运行时语言切换（语言在 `setup` 时确定一次）、不做 per-session 语言、不做 >2 种语言、不做 JSON/YAML 资源文件、不引入任何运行时依赖。
- 不改命令名/工具名/状态标识符（`active` / `usage-limited` 等仍是内部 token）。
- **不本地化配置校验错误**（`opencode-goal: option "…" must be …`）与**日志**（`console.error`）——面向运维/日志，保持英文。
- **区分**：不本地化的是 `prompts/index.ts` 的**提示词**；而 `goal` 工具 **schema** 的描述/参数说明**要**本地化（§5.6，取舍见 §8）。

## 3. 设计

### 3.1 文件结构（新 `src/i18n/`）

```
src/i18n/
  language.ts   Language / toLanguage / systemLocale / resolveLanguage（纯，可单测）
  messages.ts   interface Messages + MessageKey + format()（纯）
  en.ts         export default { ... } satisfies Messages
  zh-CN.ts      export default { ... } satisfies Messages
  index.ts      MESSAGES: Record<Language, Messages> + messagesFor(language)
  language.test.ts
  messages.test.ts
```

### 3.2 语言解析（`src/i18n/language.ts`）

```ts
export type Language = "zh-CN" | "en"

/** 取主语言子标签：zh* → zh-CN，en* → en，其余 undefined。大小写与 `_`/`-` 归一。 */
export function toLanguage(tag: string): Language | undefined

/** Intl 探测系统 locale；异常兜底 "en"。 */
export function systemLocale(): string

/** 显式优先；否则系统 locale；否则 "en"。 */
export function resolveLanguage(explicit: Language | undefined, locale: string): Language
```

- `toLanguage`：`tag.trim().toLowerCase().replace(/_/g, "-").split("-")[0]` → `"zh"` → `zh-CN`，`"en"` → `en`，其余 `undefined`。覆盖 `zh` / `zh-CN` / `zh-Hans-CN` / `en-US` / `C`（→ undefined）等。
- `systemLocale()`：`try { Intl.DateTimeFormat().resolvedOptions().locale } catch { "en" }`。

### 3.3 消息目录（`src/i18n/messages.ts`）

```ts
export interface Messages { readonly "cmd.goal": string; /* ... 全部键见 §5 ... */ }
export type MessageKey = keyof Messages

/** 把 {name} 占位符替换为 params[name]；未提供的占位符原样保留（不抛）。 */
export function format(template: string, params: Record<string, string | number>): string
```

- 实现用**函数式 replacer**（`(_, name) => params[name] ?? \`{${name}}\``），避免用户文本里的 `$&` / `$1` 被 `String.replace` 特殊解释。
- 未提供的占位符运行时**原样保留**（不抛）——但由 §6 的占位符对齐测试在编译期之外兜底。

- 值为**带占位符的字符串**（如 `"目标当前为「{status}」，无需暂停。"`），不用函数值——与 gettext/ICU 同形，翻译者只碰一个文件。
- `en.ts` / `zh-CN.ts` 均 `satisfies Messages`：**少键/多键都会 `tsc` 报错**。
- `index.ts`：`MESSAGES: Record<Language, Messages>`、`messagesFor(language)`。

### 3.4 配置项（`src/config.ts`）

- `Options` 新增 `readonly language?: Language`（`undefined` = 跟随系统）。
- 配置键 `language`：非字符串 → 抛错；字符串经 `toLanguage` 归一，能映射到 `zh`/`en` 即接受（故 `zh` / `zh-CN` / `zh_CN` / `en-US` 等均可），否则抛 `opencode-goal: option "language" must be "zh-CN" or "en"`。
- `DEFAULT_OPTIONS` **不含** `language`（缺省即跟随系统；避免 `language: undefined` 显式出现）。

### 3.5 接线

- `GoalDeps` 新增必填 `readonly messages: Messages`。
- `server.ts`：`const language = resolveLanguage(options.language, systemLocale()); const messages = messagesFor(language)`；命令描述与 `goal_debug` 工具描述改用 `messages`。
- `commands.ts`：`notice.*` / `status.*` / `label.goalRequest` 全部走 `deps.messages`；`statusLine` 与 `notice.nothingToPause` / `notice.nothingToResume` 里的 `{status}` 都用 `statusLabel(messages, status)` 取本地化状态词（否则中文回执会出现 `「active」`）。
- `continuation.ts`：`label.autoContinue` 走 `deps.messages`（`noticeLine` 保留，语言无关）。
- `notice.ts`：`signalNotice(messages, status, message)` 改签名（内部按 `signal.*` 取模板）；`noticeLine` 不变。
- `debug.ts`：表头/标签/`(none)`/`(unknown)`/yes-no 走 `deps.messages`。
- `tools.ts`：`goal` 工具 `description` 走 `deps.messages`；`goalToolInput` 由模块常量改为**按 messages 构建**，并**新增参数说明**（`op` / `objective` / `token_budget` / `blocker_key` / `blocker`）。`server.ts` 的 `goal_debug` 工具描述与 `op` 说明走 `messages`。**工具 schema 本地化作为独立任务实现**，便于单独回退（见 §8）。
- 状态词本地化：`statusLabel(messages, status)` 用穷举 `switch`（`active`/`paused`/`blocked`/`budget-limited`/`usage-limited`/`complete`）。

### 3.6 数据流

`setup` 解析 options → `resolveLanguage` → `messagesFor` → 注入 `GoalDeps` → 各 host 模块取文案。**语言在实例生命周期内固定**，无运行期分支。

## 4. 与现有机制的关系

- **不改状态机**：状态标识符与转移逻辑不变；只改**展示**。
- **不改提示词注入**：`hooks.ts` / `prompts/index.ts` 原样。
- **不改事件路由语义**：仅把 `signalNotice` 的文案来源换成 `deps.messages`。
- **热重载**：与既有机制无关；但实现期间改 `src/**` 会触发宿主热重载（见 §7）。

## 5. 文案清单（权威）

> 范围 = **TUI 面向用户**的文案 + **工具 schema**（模型可见）。**不含**：`prompts/index.ts` 的提示词、工具错误信息、工具输出 `completionBudgetReport`、配置校验错误、`console.error` 日志（见 §2）。`debug.usage` 的 en 值由现状的 `用法:` 改为 `usage:`，属修正既有中英混排。

> 占位符 `{...}` 由 `format` 替换。`en` 为默认；`zh-CN` 为中文。

### 5.1 命令描述（`server.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `cmd.goal` | Set a persistent goal for this session (empty reports the current goal). | 为本会话设置持久目标（留空则报告当前目标）。 |
| `cmd.status` | Report the current goal. | 报告当前目标。 |
| `cmd.pause` | Pause the active goal. | 暂停当前进行中的目标。 |
| `cmd.resume` | Resume a paused, blocked, budget-limited, or usage-limited goal. | 恢复已暂停、受阻、预算用尽或用量受限的目标。 |
| `cmd.clear` | Clear the goal record. | 清除目标记录。 |
| `cmd.debug` | Read-only diagnostics for the goal plugin (no model turn). | goal 插件的只读诊断（不触发模型轮）。 |

### 5.2 命令回执与标签（`commands.ts` / `continuation.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `notice.noGoal` | No goal is set for this session. | 本会话未设置目标。 |
| `notice.paused` | Goal paused. | 目标已暂停。 |
| `notice.resumed` | Goal resumed. | 目标已恢复。 |
| `notice.cleared` | Goal cleared. | 目标已清除。 |
| `notice.nothingToPause` | Goal is {status}; nothing to pause. | 目标当前为「{status}」，无需暂停。 |
| `notice.nothingToResume` | Goal is {status}; nothing to resume. | 目标当前为「{status}」，无需恢复。 |
| `label.goalRequest` | Goal request | 目标请求 |
| `label.autoContinue` | Goal auto-continue | 目标自动续跑 |

### 5.3 状态词与状态行（`commands.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `status.active` | active | 进行中 |
| `status.paused` | paused | 已暂停 |
| `status.blocked` | blocked | 已受阻 |
| `status.budget-limited` | budget-limited | 预算用尽 |
| `status.usage-limited` | usage-limited | 用量受限 |
| `status.complete` | complete | 已完成 |
| `status.line` | Goal ({status}) — tokens {tokens} / {budget}{detail}; {seconds}s{lastError}. Objective: {objective} | 目标（{status}）— tokens {tokens} / {budget}{detail}；{seconds}s{lastError}。目标：{objective} |
| `status.budget` | budget {budget} | 预算 {budget} |
| `status.noBudget` | no budget | 无预算 |
| `status.detail` |  (cacheRead {cacheRead} · new work {newWork}) | （cacheRead {cacheRead} · 新增 {newWork}） |
| `status.lastError` | ; last error: {error} | ；最近错误：{error} |

### 5.4 宿主信号回执（`notice.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `signal.usage-limited` | Goal marked usage-limited{detail}. Use /goal-resume after the limit resets. | 目标已标记为用量受限{detail}。配额恢复后可用 /goal-resume 继续。 |
| `signal.budget-limited` | Goal marked budget-limited{detail}. Use /goal-resume to continue. | 目标已标记为预算用尽{detail}。可用 /goal-resume 继续。 |
| `signal.detail` | : {message} | ：{message} |
| `signal.blocked` | Goal marked blocked{detail}. Use /goal-resume after resolving it. | 目标已标记为受阻{detail}。解决后可用 /goal-resume 继续。 |

`signalNotice(messages, status: "usage-limited" | "budget-limited" | "blocked", message)` 的实现：`detail` = 有非空 message 时 `format(messages["signal.detail"], { message: 压平后的 message })`，否则空串；再 `format(messages["signal." + status], { detail })`。冒号随语言由 `signal.detail` 提供，模板本身不含冒号。调用点 `events.ts` 需先把 `after.status`（类型 `GoalStatus`）**收窄**到上述三值联合（穷举 guard），否则 `"signal." + status` 在严格模式下编译不过。

### 5.5 调试输出（`debug.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `debug.usage` | {pluginId} debug — usage: env \| events \| sessions \| state | {pluginId} 调试 — 用法：env \| events \| sessions \| state |
| `debug.env.header` | {pluginId} debug env | {pluginId} 调试 env |
| `debug.env.instanceLocation` | instance location: {dir} | 实例 location：{dir} |
| `debug.env.session` | session: {id} | 会话：{id} |
| `debug.env.sessionDirectory` | session directory: {dir} | 会话目录：{dir} |
| `debug.env.belongs` | belongs to this instance: {verdict} | 是否属于本实例：{verdict} |
| `debug.env.options` | options: {json} | 配置：{json} |
| `debug.events.header` | {pluginId} debug events (last {n}) | {pluginId} 调试事件（最近 {n} 条） |
| `debug.sessions.header` | {pluginId} debug sessions ({n}) | {pluginId} 调试目标记录（{n} 条） |
| `debug.state.header` | {pluginId} debug state | {pluginId} 调试 state |
| `debug.state.session` | session: {id} | 会话：{id} |
| `debug.state.turnOpen` | turn open: {value} | 轮进行中：{value} |
| `debug.state.agent` | agent: {agent} | agent：{agent} |
| `debug.state.directoryCache` | session directory cache: {dir} | 会话目录缓存：{dir} |
| `debug.state.pendingAutomatic` | pending automatic: {value} | 待自动续跑：{value} |
| `debug.state.pendingBackground` | pending background: {value} | 待后台唤醒：{value} |
| `debug.state.blockedThisTurn` | blocked this turn: {value} | 本轮已受阻：{value} |
| `debug.state.goal` | goal: {goal} | 目标：{goal} |
| `debug.unknownSubcommand` | Unknown debug subcommand: {op}\n{usage} | 未知的调试子命令：{op}\n{usage} |
| `debug.none` | (none) | （无） |
| `debug.unknownValue` | (unknown) | （未知） |
| `debug.unknown` | unknown | 未知 |
| `debug.noTrackedState` | (no tracked state) | （无跟踪状态） |
| `debug.yes` | yes | 是 |
| `debug.no` | no | 否 |

> `{goal}` 的值（`status, emptyStreak=…, blockerStreak=…`）保持**原始 token**（调试用，不本地化状态词）。

### 5.6 工具描述与参数说明（`tools.ts` / `server.ts`）

| Key | en | zh-CN |
| --- | --- | --- |
| `tool.goal.description` | Manage the persistent goal for this session. op "create" starts a goal only when explicitly requested; "get" reports it; "complete" asserts evidence-backed completion; "resume"/"drop" are also available; "block" reports a recurring blocker. | 管理本会话的持久目标。op "create" 仅在用户明确要求时启动目标；"get" 报告目标；"complete" 在证据充分时声明完成；另有 "resume"/"drop"；"block" 上报反复出现的阻碍。 |
| `tool.goal.op` | Operation: create \| get \| complete \| resume \| drop \| block. | 操作：create \| get \| complete \| resume \| drop \| block。 |
| `tool.goal.objective` | Objective text for op "create". | 目标正文（op "create" 时使用）。 |
| `tool.goal.tokenBudget` | Optional token budget for op "create". | 可选 token 预算（op "create" 时使用）。 |
| `tool.goal.blockerKey` | Stable blocker key for op "block". | 稳定的 blocker 键（op "block" 时使用）。 |
| `tool.goal.blocker` | Short blocker description for op "block". | 简短的 blocker 描述（op "block" 时使用）。 |
| `tool.debug.description` | DEBUG ONLY — read-only diagnostics for the opencode-goal plugin (which location owns this session, recent event-ownership decisions, stored goals, in-memory turn state). Do NOT call this during normal goal work. Call it only when the user explicitly asks to debug the goal plugin, or when goal auto-continuation misbehaves. | 仅调试用——opencode-goal 插件的只读诊断（本会话归属哪个 location、最近的事件归属判定、已存目标、内存中的轮状态）。正常目标工作期间不要调用；仅当用户明确要求调试该插件、或目标自动续跑行为异常时调用。 |
| `tool.debug.op` | Which diagnostic to render (debug-only; never call speculatively). | 要渲染哪项诊断（仅调试用；不要凭空调用）。 |

> `goal` 工具的参数说明是**新增**（当前 schema 无 per-property description）；`goal_debug` 的描述为**已有英文的本地化**。

## 6. 测试与验收

**单测**：

- `i18n/language.test.ts`：`toLanguage`（`zh`/`zh-CN`/`zh-Hans-CN`→`zh-CN`；`en`/`en-US`→`en`；`C`/``/`fr`→`undefined`；大小写与 `_` 归一）；`resolveLanguage`（显式优先；系统 `zh-CN`→`zh-CN`；系统 `fr`→`en`；显式与系统都空→`en`）；`systemLocale()` 返回非空字符串。
- `i18n/messages.test.ts`：
  - `format` 替换已知占位符、未提供占位符原样保留、数字转字符串、含 `$&`/`$1` 的文本不被特殊解释。
  - 两语言**键集合一致**（运行时断言，作为 TS 之外第二道防线）；无空值。
  - **占位符对齐**：对每个键，从 en/zh 值中提取 `{...}` 集合并断言相等（`satisfies Messages` 只校验键与类型，**不校验占位符**）。
  - **无残留占位符**：对组合模板（`status.line`、`signal.*`、`debug.*`）用完整参数渲染后断言不含 `/\{[a-zA-Z]+\}/`。
  - 防「忘了翻」：抽样断言 zh 与 en 值**不相等**（不断言「含汉字」——`signal.detail` 的 zh 值 `：{message}` 无汉字）。
- `config.test.ts`：`language` 缺省 → `undefined`；`"zh"`/`"zh-CN"`/`"EN"`/`"zh_CN"` 归一；非字符串或无法识别 → 抛错；`DEFAULT_OPTIONS` 不含 `language`。

**现有测试适配**：

- 构造 `GoalDeps` 的测试 helper 补 `messages: messagesFor("en")`（保持英文断言不变）：`src/host/commands.test.ts`、`src/host/continuation.test.ts`、`src/host/debug.test.ts`、`src/host/events.test.ts`、`src/host/hooks.test.ts`、`src/host/tools.test.ts`。`notice.test.ts` / `turn.test.ts` / `plan.test.ts` / `generation.test.ts` 不构造 deps，无需改。
- `src/server.test.ts` **不构造 `GoalDeps`**（走 `plugin.setup(mockCtx)`）：其 `mockCtx` 的 `options` 由 `{}` 改为**显式 `{ language: "en" }`**，否则 `setup` 会按本机系统 locale（`zh-CN`）解析，导致 `"Goal request · ship it"` / `toContain("debug env")` 等英文断言失败。**凡经 `setup` 的测试都必须显式固定语言**，不得依赖机器 locale。
- `tools.ts` 的 `goalToolInput` 由模块常量改为按 messages 构建（当前仅 `tools.ts` 内部使用，无外部导入）。
- 另补**少量中文用例**：如 `commands.test.ts` 用 zh-CN 断言 `notice.noGoal` 文案、`tools.test.ts` 断言工具描述随语言变化。

**验收**：`bun test` 全绿 + `bunx tsc --noEmit` 无错。

**真机**（可选）：把插件配置临时设为 `{ "language": "zh-CN" }` 跑 `/goal-status`，确认 TUI 回执为中文；再移除配置，确认跟随系统（本机应仍为中文）。

## 7. 实施注意

- 改 `src/**` 会触发宿主热重载。沿用上次做法：**实现期间临时把插件从 `~/.config/opencode/opencode.json` 移除**，全部改完再复原（并确认 JSON 合法）。
- `GoalDeps` 新增必填字段会波及所有测试 helper——属预期改动，不是回归。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 本地化 `goal` 工具 schema（模型可见）可能降低模型对工具的遵循度 | 已知取舍；用户已确认。英文用户仍得英文 schema。若实测退化，可回退为「工具描述保持英文」 |
| 系统 locale 探测到意外值（`C` / `POSIX` / 空） | `toLanguage` 取主语言子标签 + 兜底 `en`；配置项可显式覆盖 |
| 宿主 server 进程的 locale 与用户预期不符（如以 `LANG=C` 启动） | 配置项 `language` 覆盖 |
| 漏翻某键 | `satisfies Messages` 编译期报错 + `messages.test.ts` 运行时键集合断言 |
| 占位符跨语言不对齐（`satisfies` 不校验占位符） | `messages.test.ts` 提取两语言占位符集合断言相等 + 组合模板渲染后无残留 `{...}` |
| `setup` 级测试依赖机器 locale → 断言随机器变化 | 经 `setup` 的测试显式传 `language`（§6），不依赖系统探测 |
| 插件语言与宿主 UI 语言不一致（宿主 UI 有独立 i18n，但不暴露给插件，见 §9） | `language` 显式覆盖；文档说明 |
| 配置校验错误未本地化（英文） | 已声明为非目标（§2） |

## 9. 参考

- 宿主：`packages/plugin/src/**`（`Plugin.Context` 无 locale，已核实）；宿主 UI 侧另有独立 i18n（`packages/app/src/runtime/i18n/language.tsx`、`packages/ui/src/context/i18n.tsx`），但**不通过插件 API 暴露**，故插件只能用 `Intl` 探测系统 locale。
- 生态参考：OMP `packages/coding-agent/src/**/i18n.ts`、prevalentWare 插件 `i18n.ts`（均为 TS 模块字典）。
- 本仓库：`src/host/commands.ts`、`src/host/notice.ts`、`src/host/continuation.ts`、`src/host/debug.ts`、`src/host/tools.ts`、`src/server.ts`、`src/config.ts`、`docs/opencode/config-install.md`。

## 10. 修订记录

- **2026-09-25（初稿）**：确认宿主不提供 locale、系统 locale 可探测；确定「每语言一 TS 模块 + 键值字典 + `{占位符}` + `format`」；默认跟随系统 + `language` 覆盖；范围 = 用户可见文案 + 工具描述/参数说明（不含模型提示词/工具错误/工具输出）；完成全部文案清单。
- **2026-09-25（独立子代理审阅后修订，并入 8 条）**：① §6 修正 `server.test.ts` 适配（走 `setup`，须显式 `language: "en"`，否则被系统 locale 带成中文）；② §5.5 补 3 处遗漏的用户可见调试字符串（新增 `debug.unknown` / `debug.noTrackedState`，原「Unknown debug subcommand」更名 `debug.unknownSubcommand`）；③ §1 措辞（并非全英文，`debug.usage` 已中英混排）；④ §9 更正宿主 UI 有独立 i18n、只是不暴露给插件，并在 §8 补该风险；⑤ §2/§5 明确配置校验错误与 `console.error` 日志保持英文（非目标）；⑥ §5.4 `signalNotice` 形参收窄为三值联合并在调用点 guard；⑦ §6 新增占位符对齐与无残留测试；⑧ §3.5 `notice.nothingToPause/Resume` 的 `{status}` 也走 `statusLabel`。
