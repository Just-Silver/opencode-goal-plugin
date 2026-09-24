# pi 生态的 Goal 插件生态（星标排序）

> OMP（`can1357/oh-my-pi`）是 `badlogic/pi-mono` 的 fork；pi 有一整套 goal 扩展生态。
> OMP 本身**原生内置** goal（见 `docs/omp/`），下列多为 **pi** 的扩展。
> 采集日期 2026-09-24，来自 `gh search repos`。

## 1. 上游与宿主

| 星 | 仓库 | 说明 |
|---:|---|---|
| 33.1k | `can1357/oh-my-pi` (OMP) | pi 的 fork，"coding agent with the IDE wired in"，**原生 goal mode** |
| — | `badlogic/pi-mono`（Mario Zechner / mariozechner） | pi 原仓（被 fork 的上游） |

## 2. pi 的 goal 插件（按星）

| 星 | 仓库 | 说明 |
|---:|---|---|
| 225 | `Michaelliv/pi-goal` | **"Persistent autonomous goals for pi"**（pi 生态最高星） |
| 193 | `fitchmultz/pi-codex-goal` | "Codex-style goal tracking and continuation for pi"；状态存 pi session custom entries（跟随 session 历史/resume/fork/tree/compaction） |
| 72 | `tintinweb/pi-supervisor` | "goal oriented Pi-Agent extension that supervises the coding agent and steers it toward a defined outcome" |
| 68 | `tmonk/pi-goal-x` | `/goal`；会话式目标规划、flexible/ordered goals、持久进度、**独立完成审计器** |
| 26 | `transcendr/pi-goals` | 持久目标 + 队列 + 预算 + 可复用提示 + churn 监控 + 上下文交接 |
| 26 | `edxeth/pi-ralph-loop` | 在 pi 里跑 Ralph Wiggum loop（原生命令控制；宣称"better than Codex goals"） |
| 24 | `DraconDev/pi-goal-list-loop-audit` | "Goal. Loop. Audit. Done."；**每次完成用隔离的 auditor 会话**（无扩展/技能/编辑器）复核 |
| 21 | `capyup/pi-goal` | goal mode + `/goal-set` 起草 + sisyphus 步骤门禁 + autoContinue + 状态浮层 |
| 19 | `code-yeongyu/pi-goal` | "Persistent Codex-style goal tracking extension for pi"（**已被 `wejick/opencode-goal` 移植到 OpenCode V2**） |
| 17 | `tchivs/gsd-omp` | **OMP 宿主插件**：GSD 编排系统 + 可选 Goal Mode 状态集成 |
| 17 | `MuseLinn/pi-muselinn-harness` | Kimi Code 风格编排 harness（Swarm/Goal/Plan/Permission/Task/Hooks/Skills/TUI） |
| 14 | `PurpleMyst/pi-goal` | "Codex /goal clone for Pi" |
| 2 | `izzzzzi/pi-goal-pro` | 无进展检测、证据式完成、token 预算、自动续跑 |

## 3. `code-yeongyu/pi-goal` 细节（因被移植到 OpenCode，值得单列）

- 命令：`/goal <objective>`、`/goal`、`/goal pause`、`/goal resume`、`/goal clear`。
- 工具：`create_goal({objective})`、`update_goal({status:"complete"|"blocked", reason?})`、`get_goal`。**Statuses: active / paused / blocked / complete**；pause/resume 由用户或系统控制。
- TUI：Codex 风格 footer 指示器（`Pursuing goal (...)` / `Goal paused (/goal resume)` / `Goal blocked` / `Goal achieved (...)`）。
- 续跑：session_start、`/goal`、`/goal resume`、以及"每轮结束仍 active"时，把 Codex 的 continuation prompt 作为**隐藏 model-visible 上下文**排队；objective **XML 转义并包成不可信用户数据**。
- 阻塞：**同一阻塞连续 ≥3 轮**才可 `blocked`；resume 后重新计数。
- 中断：活跃轮以 `ctx.signal.aborted` 结束 → 记录"user interrupted the turn"并抑制续跑；下一个真实用户提示会先 resume 该 blocked goal。
- 预算：达到 token 预算 → `budgetLimited` + 排队"总结剩余工作"提示。
- 对照 Codex `codex-rs/ext/goal`：工具/参数描述、`update_goal` 错误文案、完成预算报告**逐字对齐**；刻意**省略 `usage_limited`**（pi harness 没有该信号）。

## 4. 观察

- pi 生态的 goal 插件数量远多于 OpenCode，且**竞争充分**：独立审计器（tmonk、DraconDev）、todo 集成、Ralph loop、队列/多目标等方向都有人做。
- **`code-yeongyu/pi-goal` 是"Codex 语义 → TS harness"的最直接移植范本**，对"我们要在 OpenCode 上做同类"参考价值最高。
- OMP 的**原生**实现（`docs/omp/`）比这些扩展更完整（记账、隐藏 steer、todo、guided interview）。
