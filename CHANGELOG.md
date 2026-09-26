# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.1] - 2026-09-26

### Changed

- **命令顺序**：会话命令按「主 → 查看 → 修改 → 生命周期 → 调试」排列：`/goal`、`/goal-status`、`/goal-rebuild`、`/goal-budget`、`/goal-pause`、`/goal-resume`、`/goal-clear`、`/goal-debug`。

## [0.4.0] - 2026-09-26

### Added

- **重建目标正文**：新增命令 `/goal-rebuild <新目标>`，只替换目标正文（`objective`），状态、预算、用量与自动续跑记账全部保留；确定性、零 token、不唤醒模型。工具面不变——agent 依旧不能修改目标。

### Changed

- **`/goal-status` 状态行改为多行**：状态、指标（`已用 tokens / 预算 / 缓存读取 / 新增`）、`创建于 … · 耗时 … · 自动续跑 …`、目标正文各占一行，参数带中文标签（英文对应 `tokens used / budget / cache read / new work / created`）。

### Fixed

- **`/goal` 询问时机**：命令提示词明确澄清提问只在创建目标之前，创建后不再回头问。

## [0.3.0] - 2026-09-26

### Added

- **自动续跑计数**：目标累计记录自动续跑次数，展示在 `/goal-status`、续跑回执（`目标自动续跑 #N`）、`goal(op="get")` 返回与 `/goal-debug state`。
- **预算随时可改**：新增命令 `/goal-budget <正整数|none>`（`none` 取消预算，不限）与工具 `goal(op="budget", token_budget=…)`（`0` = 无预算）；把预算改到够用会把 `budget-limited` 的目标自动恢复为进行中，仍受 `max_goal_token_budget` 约束（`none` 除外）。

## [0.2.1] - 2026-09-25

### Changed

- **`/goal <目标>` 的回执显示完整目标**（不再截断到 72 字，TUI 自动换行）；自动续跑的回执仍裁剪，避免长目标每轮刷屏。

## [0.2.0] - 2026-09-25

### Added

- **后台任务 deferral**：后台 shell / 后台 subagent 运行期间，轮末**不再**自动续跑；宿主完成通知（`session.inbox.enqueued`）到达后恢复。起/止信号取自工具结果 metadata（`status:"running"`）与完成通知 metadata（`source:"shell"|"subagent"`），并带最外层标签文本兜底与乱序护栏。纯内存、不落 KV、不加配置项、不做超时放行（依赖宿主「完成即唤醒」保证）。
- **宿主终态信号 → 状态**：一轮因宿主终态错误失败（`session.execution.failed`）时按 `error.type` 改目标状态——配额/限流（`provider.quota`，含 Go/Free 用量上限）→ **`usage-limited`**；确定性拒绝（`provider.auth` / `provider.content-filter` / `provider.invalid-request`）→ **`blocked`**。记录 `lastError`、发一条纯回执、支持 `/goal-resume` 恢复。**排除** `provider.no-route`（与热重载 `ModelUnavailableError` 共用，避免误伤）等；不改配置、不做自动恢复、不干预重试。
- **国际化（i18n）**：面向用户文案（命令描述、`/goal-*` 回执、状态行、宿主信号回执、`/goal-debug` 输出）与 `goal` 工具描述/参数说明支持中英双语；语言默认跟随系统 locale（`Intl` 探测），可用配置项 `language` 显式覆盖。模型提示词与日志保持英文。

## [0.1.1] - 2026-09-25

### Changed

- **token 记账口径改为「真实处理量」**：`tokensUsed` 现计 `input + output + reasoning + cacheRead + cacheWrite`（原先只计 `output + reasoning + cacheWrite`）。原先漏掉 cacheRead —— 在有 prompt cache 的长会话里它约占 98%，导致 `token_budget` 严重低估、形同虚设。与 Codex / OMP 不同（它们排除 cacheRead），这是有意的「消耗量」口径（详见 spec §3/§10）。
- **命令面改为多命令（破坏性）**：去掉 `/goal pause|resume|clear|status` 的后台拦截 —— 宿主没有子命令概念，打错一个字（`/goal paus`）就会变成目标文字。状态控制改为**独立命令** `<command_name>-status` / `-pause` / `-resume` / `-clear`（默认 `goal-status` 等），能出现在 `/` 补全里；`/goal <目标>` 现在只用于设目标，`/goal` 空参仍报告状态。**旧写法不再被拦截**：`/goal pause` 会被当成目标文字。
- **修掉收尾轮漏记**：`step.ended` 只累加进内存，**轮末（或中断）一次性落账**；原先状态一旦翻成 `complete` / `blocked` / `budget-limited`，同一轮后续 step 的 token 全部丢失。副作用：不再每个 step 写一次 KV，改为每轮一次。
- `/goal status` 与 `goal` 工具返回附上分项（`cacheRead` / 「新工作」量），并**叠加本轮尚未落账的用量**（轮内实时；否则改成轮末落账后，`complete` 那一刻会报 0）。叠加只在「本轮 token 会归属该目标」时生效，且**分项仅在五项之和等于 `tokensUsed` 时展示**（旧记录升级后只给总量，避免展示对不上的数字）。

### Added

- 目标记录新增可选 `usage` 分项（`input` / `output` / `reasoning` / `cacheRead` / `cacheWrite`）。旧记录没有该字段，只显示总量。

### Fixed

- `/goal-debug events` / `sessions` 的时间戳改为**本地墙钟时间**（`HH:mm:ss.SSS`）；原先用 `toISOString()` 输出 UTC，与本地时间差一个时区，纯属显示误导。
- **reload 泄漏旧插件激活导致的 N 倍续跑与内存增长**（宿主在 location 活跃时 reload 不调旧代际 cleanup）：插件侧加**进程级代际守卫**（`globalThis` 共享、按 location 记录当前代际 + AbortController），新一代 setup 先 abort 旧代；事件循环与钩子校验 `isCurrent()`，cleanup 只有当班才注销。根因与探针证据见 `docs/opencode/known-issues.md`，上游 issue #36677。

### 注意

- 旧目标的 `tokensUsed` 与新口径不可比（**不重算**）；`usage` 分项从本版本起才开始累计 —— 因此旧记录**只显示总量**，分项要到「五项之和 == `tokensUsed`」（即从 0 开始累计的新目标）才展示。

## [0.1.0] - 2026-09-25

首个公开发布。

### Added

- **`/goal` 命令**：一次一问地引导出目标，自适应创建持久目标（可带 token 预算）。
- **`goal` 工具**：`get` / `complete` / `pause` / `resume` / `clear` / `block` 等操作；工具直连注册（不进 Code Mode 目录）。
- **空闲自动续跑**：一轮结束且无未完成工具调用时，自动发一行触发语唤醒模型继续，直到目标完成、暂停、阻塞或超出预算。
- **目标上下文注入**：目标本体（objective + 状态 + 预算 + 全部行为规则）经 `session.hook("context")` 追加到 **system** 部分，只存在于当次请求、不落消息、不进转录；每轮只落一行 48 字符的续跑触发语。
- **证据式完成**：`complete` 需要给出完成证据；完成 / 阻塞前强制复核目标全文。
- **护栏**：token 预算（`token_budget` / `max_goal_token_budget`）、连续阻塞阈值（`blocked_threshold`）、空转阈值（`empty_threshold`）、受限 agent（`restricted_agents`）、目标注入截断（`max_objective_chars`）。
- **持久化**：per-session 存储于宿主 KV（`goal:<sessionID>`）；多 location 下按事件归属判定互不干扰。
- **启动兜底 reconcile**：清理宿主侧已不存在的会话残留记录（带 `reconcile_guard_minutes` 保护窗，默认 5 分钟）。
- **`/goal-debug` 命令与 `goal_debug` 工具**：`env` / `events` / `sessions` / `state` 四条诊断通道（纯文本输出）。

### Fixed

- **删除会话后目标记录残留**：`session.deleted` 的事件 payload 不带 `location`，原先会被归属判定判成「不属于本实例」而丢弃，清理从不执行；现豁免删除事件的归属判定（`remove` 幂等，多实例重复执行无害）。
- **reconcile 冷启动清不掉孤儿记录**：插件侧 `ctx.session.get` 抛的是 `Schema.TaggedError`（`Session.NotFoundError`，**没有 `status` 字段**），原先只认 `status === 404`，因此永远判不出「会话不存在」；现改认 `_tag`，其余错误一律保守跳过（宁可留，不可误删）。

### Security

- 插件自身**不 spawn 任何子进程**（无 `child_process` / `spawn` / `exec` / `fork`）。
- **无第三方运行时依赖**：运行时只 import 相对路径模块与宿主提供的类型。
