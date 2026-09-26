# 自研设计取向（v1，逐步定稿）

> 基于 `docs/00-comparison.md` + Codex/OMP 源码 + 与用户讨论逐步定稿。
> 状态标记：**[定]** 已拍板 ／ **[议]** 待议。
> **原则：OMP 与 Codex 一致处直接照抄；仅在其分歧或 OpenCode 约束处才讨论。**
> 更新：2026-09-24。
>
> **实现状态（2026-09-25，v0.2.0）**：本文是 v1 取向快照。§7「阶段二」各项已陆续交付——`usage-limited` + 宿主终态错误 → `blocked`（V2 子项目 3，`2026-09-25-opencode-goal-v2-host-signals-design.md`）、子会话/后台 deferral（V2 子项目 2，`2026-09-25-opencode-goal-v2-background-deferral-design.md`）、i18n（`2026-09-25-opencode-goal-v2-i18n-design.md`）。**仍待做**：TUI 侧边栏（V2 子项目 5）。正文未逐条改写，以本说明与各 spec 为准。

## 0. 定位

在 **OpenCode** 上做 Codex/OMP 式的 goal 模式：会话级持久目标 + 空闲续跑 + 证据式完成。
**server 侧插件**，用**配置安装**（`opencode.json(c)` 的 `plugins` 一行）。

## 1. 分发与注册 **[定]**

- 配置安装：`{ "plugins": ["<npm名 或 github:owner/repo#ref>"] }`。
- **插件自己注册命令 + 工具**；用户不写 `command` 配置，命令自动出现在 TUI/desktop/web 的命令面板（`/`）里。
  - V2：插件加载时经 `context.command.transform(draft => draft.add({name, description, execute}))` 注册。
  - V1：插件经 config 钩子注入命令定义（等价形态）。
  - 工具同理在插件加载时注册。
- 目标：**一行配置 = 命令可用 + 工具可用**，无需 script 安装、无需发 npm（也可发 npm 以便自动更新）。

## 2. 命令面（用户入口）**[定]**

**多命令，而非子命令**（宿主没有子命令概念，后台拦截保留名容易误触）：

| 命令 | 作用 |
| --- | --- |
| `/goal <text>` | 模型先判断输入信息是否足够（可判定成功标准 / 验证方法 / 范围边界 / 停止条件）：够 → 自动结构化后直接 `create`；不够 → 先访谈（一次一问、≤6 问），问全再 `create` |
| `/goal-status` / `-pause` / `-resume` / `-clear` | 生命周期控制（**服务端确定性处理**，不经模型）；名字跟随 `command_name` |

- 对齐 superpowers 的 brainstorm-before-build：**先把目标逼到可验证，再让它自主跑**；由模型按输入质量**自适应**决定是否追问。
- 命令是"薄壳"：把用户输入包装成受控 prompt，让模型调用单一 `goal` 工具（或直接由服务端处理 pause/resume/clear）。

## 3. 模型工具面 **[定]**

**单一工具 `goal` + `op` 枚举**（OMP 式，省 context、strict schema、返回统一）：

```ts
goal({
  op: "create" | "get" | "complete" | "resume" | "drop" | "block",
  objective?: string,
  token_budget?: integer,
  blocker_key?: string,   // op=block：稳定 slug，服务端据此计数
  blocker?: string        // op=block：阻塞描述（展示用）
})
```

- 模型可 `complete` / `resume` / `block`（block 仅"报告"，是否 blocked 由服务端裁决）。
- **`pause` / `clear` 不暴露为 op**（用户命令处理）。
- 返回：`{ goal, remainingTokens, completionBudgetReport, blockerStreak? }`。
- `create` 仅在**显式请求**（命令或用户明说）时；已有未完成目标时失败并提示。

## 4. 状态机 **[定]**

`active | paused | blocked | budget-limited | usage-limited | complete`（`usage-limited` 由宿主信号置位，**已实现**）。

不设终态 `unmet`——**"放弃/丢弃"由用户 `/goal clear` 处理**（[定]）。

权限与设置方：

| 状态 | 谁设 | 规则 |
| --- | --- | --- |
| `active` | 创建 / resume | — |
| `paused` | 用户命令 / 系统 | `/goal-pause`，或中断/失败 |
| `blocked` | **服务端裁决**（模型只报告） | 模型调 `goal({op:"block", blocker_key, blocker})` 报告；**服务端只按 `blocker_key` 数连续轮**：同 key 连续报 `>= 3` 才置 `blocked`；换 key 重数；任一轮未报 block / `resume` / 新建目标 → 归零 |
| `budget-limited` | 系统 | 记账后 tokens 超预算 |
| `complete` | 模型 | 需证据审计通过 |
| `usage-limited` | 系统（条件） | 宿主上报"额度/限流"错误时；拿不到信号就不做 |

blocked 状态字段：`blockerKey`（稳定 slug）、`blockerText`（展示）、`blockerStreak`（计数）。阈值可配，默认 3。

> **无服务端启发式。** 不使用"输出 token 阈值"，也**不使用"这一轮有没有工具调用 / 连续 N 轮无工具调用"**作为阻塞或抑制依据——不稳定，且会误伤只读调研轮。是否同一阻塞由**模型**判断（复用 / 新建 key）；是否置 `blocked` 由**服务端按 key 计数**裁决。反跑飞只靠**预算 / 时长**（`budget-limited`）。
>
> blocked 的完整规格见 §4.1。

### 4.1 blocked 规格

- **性质**：非终态，可 `resume`；语义 = 模型报告"被外部因素/缺失输入卡住，无法有意义推进"。
- **分工**：**模型判断**"是否同一阻塞"（复用或新建 `blocker_key`）；**服务端计数裁决**是否置 `blocked`。模型不能直接置 `blocked`。
- **字段**：`blockerKey: string | null`、`blockerText: string | null`、`blockerStreak: number`、阈值（默认 3，可配）。
- **工具**：`goal({op:"block", blocker_key, blocker})` 报告；`goal({op:"get"})` 返回当前 `blockerKey` 与 `blockerStreak`（供模型复用 key、知道还差几轮）；未达阈值时返回"已记录 n/3，继续推进"。

**计数规则（只用 block 调用 + 轮边界，零启发式）**

| 情形 | 服务端 |
| --- | --- |
| 报 block，key 与上次相同 | `streak += 1` |
| 报 block，key 不同 | `key = 新`，`streak = 1`（重数） |
| 某一轮未报 block | `streak = 0`（链条断） |
| `resume` / 新建目标 / `clear` | `streak = 0`、清 key |
| `streak >= 阈值` | 置 `blocked`（保留 `blockerText`） |

**空转判定（照抄 Codex，独立于上面的 key 计数）**

- `empty = automatic && empty_final && !has_activity`；`has_activity` = 非空文本 / 思考 / 提问 / 工具调用；连续 **3** 个自动续跑轮空 → `blocked`。
- 用 v2 事件重建：`session.next.text.ended` / `reasoning.ended` / `tool.called|success` / `step.started|ended` / `step.failed` / `retried`。
- **不用 token 数判空**（`tokens.output` 只用于记账）。

**key 归一化与一致性**

- 归一化只做保守清洗：`trim + lowercase + NFKC + 非字母数字→"-" + 截断`；**不做模糊/语义匹配**（服务端无法也不应"识别不同的阻塞"）。
- 一致性靠：把当前 key **回灌**给模型 + 提示词强制"同一阻塞必须复用完全相同的 key" + kebab-case 命名规范。
- 假阴性（漏报/乱换 key → 判不出 blocked）由**用户手动处理**（pause/clear）；若设了 `token_budget` 则由预算兜底（照抄 OMP/Codex 的可选预算）。

- **收尾**：`blockerStreak` 达阈值、服务端置 `blocked` 时，**由那次 `goal({op:"block"})` 的返回**带上收尾指令（停止推进 + 总结阻塞 / 已尝试 / 需要用户提供什么），不另发消息（[定]）。
- **待定**：`budget-limited` 与 `blocked` 同时成立时的优先级。

## 5. 续跑与上下文注入 **[定]**

- **idle 触发**（轮末才续、不打断）；中断 → 暂停；会话恢复**默认不自动续**。
- **续跑轮**：注入完整 continuation prompt（XML 转义 objective + 预算 + 完成审计 + blocked 门槛）。
- **常态（普通用户轮）**：只注入**轻量** goal 提醒（"有 active 目标 → 先 get_goal；仅 active 才继续"），**不塞完整 objective**（学 Codex，省 token；模型需要时自行 `goal({op:"get"})`）。
- **压缩恢复**：压缩时注入目标快照 + 常态轻量提醒 + 模型 get_goal 即可恢复，无需每轮背全文。
- （子会话/工具 deferral：**已交付**，见 V2 子项目 2；OpenCode 通用 post-compaction 续跑的抑制：仍未做。）

## 6. 记账与持久化 **[定·倾向]**

- **token delta（0.1.1 起）**：计 **`input + output + reasoning + cacheRead + cacheWrite`**（真实处理量）。cacheRead 是每轮重读整个上下文的量，既是真实消耗也是 runaway 最灵敏的信号；Codex/OMP 只算「新工作」（不含 cacheRead），我们有意不同。分项一并存进记录，`status` 可展示「总量 / 重读 / 新工作」。
- **记账时机**：每个 `session.step.ended` **增量落盘一次**（对齐 codex 的 `on_tool_finish` / omp 的 `onToolCompleted`），轮末/中断再结算残留；最坏丢失窗口 = 一次模型调用（收尾轮不再漏记）。
- **墙钟**：按秒累加，差值记账。
- **串行化**：宿主**串行派发事件**（`for await … await router.handle`），写点天然不交错；写成功后清零累加器，保证同一段用量只写一次。
- **落盘节流**：**不做定时节流**；用「delta>0」变化门控（空写跳过）。
- 持久化：JSON 文件 + **原子写**（temp + fsync + rename + 目录 fsync），损坏隔离；**超长目标整段省略**（不截断，避免"截断把限制变授权"）。

### 6.1 状态存储与清理 [定]

- **存储**：官方 **`ctx.storage`**（持久 KV，SQLite 后端，按插件 ID 命名空间隔离）。**不再自建文件**（无原子写/fsync/权限/路径/损坏处理）。
- **每会话一条记录**：key `goal:<sessionID>`，value 为一个 JSON：
  - 目标（含 **>4000 字符的完整原文**）、status、token 预算/用量、时间、`blockerKey/blockerStreak`、`autoTurns`、`lastContinuationAt`、`version` 等。
  - 即 **"会话文件 + 目标引用文件"合并成同一条记录**；超长目标不再需要单独文件。
  - `<sessionID>` = OpenCode 会话 ID。
- **清理（事件驱动）**：`session.deleted` → `storage.remove("goal:<id>")`；`/goal-clear` 同。`complete/paused/blocked/budget-limited` 保留。（**注意**：该事件不带 `location`，归属判定必须豁免它；见 gotchas §8.2。）
- **启动兜底 reconcile**：`storage.scan({prefix:"goal:"})` 得本地 ID；用**官方 `ctx.session.get(id)` 判活**；不存在且记录 `updatedAt` 超过 5 分钟 → remove（mtime 保险的等价物）。查不到/出错一律跳过、不删。只在**启动**跑一次。（**实现偏差已修**：见 `plugin-dev-gotchas.md` §8.1——插件侧的「不存在」是 `_tag: "Session.NotFoundError"`，**没有** `status`。）
- **超长目标的注入**：续跑注入摘要 + "调 `goal({op:"get"})` 取完整目标"（**工具引用取代文件路径**）；完成审计强制 `get_goal` 复核。

## 7. 已定 / 待议

**已定**（参考实现一致或已拍板）：
- 默认自动续跑：**active 即续**（OMP/Codex 一致）。
- 默认预算：**不限**（一致）。
- 目标长度：**上限 4000 字符**；超出**仍在 KV 里存全文**，续跑注入摘要 + `goal({op:"get"})` 取全文（不截断、不拒绝、无需文件）。
- 作用域：**per-session**（Codex/OMP 均会话级）。
- TUI 可视化：**待做**（V2 子项目 5；按 config-install 方案 B：不用 Solid/JSX）。
- `blocked`：**要**，采用"模型报 blocker + 服务端连续轮计数（blocker_key，阈值 3）"。
- **上限**：`token_budget` 可选（默认无）＋可选 `max_goal_token_budget` 配置；**无轮次/时长上限**（照抄 OMP/Codex）。

**已确认（v2 分支源码核对，2026-09-24）**：
- **命令注册**：`ctx.command.transform(e => e.add({ name, description, execute }))`；`execute` 为**服务端回调** → `pause/resume/clear` **服务端确定性处理**。
- **运行时钩子**：`ctx.session.hook("context")`（含 `agent`）、`ctx.session.hook("compaction")`、`ctx.session.hook("retry")`（含 `error`+`decision`）、`ctx.tool.hook("execute.before/after")`（含 `agent`）、`ctx.event.subscribe`。
- **Plan 拦截**：读 `context.agent`（或工具钩子的 `agent`）；`restricted_agents`（默认 `["plan"]`）。
- **持久化**：`ctx.storage`（持久 KV）+ reconcile 用 `ctx.session.get(id)`。
- **token 来源**：assistant 消息 `tokens{input,output,reasoning,cache{read,write}}` / `step.ended{tokens}`。

**阶段二进展（2026-09-25 更新）**：
1. `usage-limited`：**已交付**（V2 子项目 3，v0.2.0）——`provider.quota` → `usage-limited`。
2. 宿主终态错误 → 自动 `blocked`：**已交付**（V2 子项目 3）——仅 `provider.auth` / `provider.content-filter` / `provider.invalid-request`；`no-route` 等**明确排除**（见下表）。
3. i18n：**已交付**（v0.2.0）——面向用户文案与工具 schema 中英双语，默认跟随系统 locale。
4. 子会话/后台 deferral：**已交付**（V2 子项目 2，v0.2.0）。
5. TUI 侧边栏：**待做**（V2 子项目 5）。

**宿主信号 → 状态映射（实现后口径）**

| 宿主信号 | 映射 | 状态 |
| --- | --- | --- |
| `provider.auth` / `provider.content-filter` / `provider.invalid-request` | `blocked` | 已交付 |
| `provider.quota`（含 Go/Free 用量上限） | `usage-limited` | 已交付 |
| `provider.no-route` / `provider.timeout` / `provider.unsupported-operation` / 全部可重试类 | **不改状态** | 已交付（有意排除） |
| 连续 3 轮自动续跑 `empty_final && !has_activity` | `blocked` | v1 |

## 8. 参考

- `docs/00-comparison.md`：三方对比
- `docs/codex/README.md`、`docs/omp/README.md`：源码级设计
- `docs/opencode/config-install.md`：分发方式（含 TUI 规避方案 B/D）
- `docs/pi-ecosystem/README.md`：pi 生态参考
