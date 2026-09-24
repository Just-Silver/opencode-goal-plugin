# OpenAI Codex CLI `/goal` —— 设计笔记（源码级）

> 参考实现：`openai/codex` → `codex-rs/ext/goal/`（Rust）。
> 原始源码归档在 `docs/codex/sources/`。采集日期 2026-09-24。
> 结论基于阅读归档源码所得，未在本机运行 Codex。

## 1. 定位

Codex 的 Goal 是**线程级（thread-scoped）的持久化完成契约**：把目标存成运行时的一等实体（不是聊天消息），跨轮次存活，到点自动续跑，且只有**证据充分**才算完成。
官方文档：`developers.openai.com/codex/use-cases/follow-goals`、cookbook `using_goals_in_codex`。
功能由 `[features] goals = true` 开启（`codex features enable goals`）。

## 2. 状态机

持久化层 `thread_goals` 表的 `status` CHECK 约束（`state/goals_migrations/0001_thread_goals.sql`）：

```
active | paused | blocked | usage_limited | budget_limited | complete
```

TUI 侧展示为：`pursuing` / `paused` / `achieved` / `unmet` / `budget-limited`。

关键分工：**模型只能设 `complete` / `blocked` / `paused`**；`resume`、`budget_limited`、`usage_limited` **只能由用户或系统设置**（见 `tool.rs` 对 status 的校验与 `spec.rs` 的工具描述）。

## 3. 数据模型（SQLite）

`0001_thread_goals.sql`：

```sql
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN
        ('active','paused','blocked','usage_limited','budget_limited','complete')),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

`0002_thread_goal_continuation_deferrals.sql`：单独一张**续跑延迟（deferral）**表，`thread_id` 外键 `ON DELETE CASCADE`。用于"当前不该自动续跑"的标记（例如 `Task` 子会话 / orchestrator 未回收）。

## 4. 模型工具（`spec.rs`）

三个 Responses API 工具（非 `strict`）：

| 工具 | 参数 | 约束 |
| --- | --- | --- |
| `get_goal` | 无 | 返回状态、预算、token/时间用量、剩余预算 |
| `create_goal` | `objective`(必填)、`token_budget`(可选) | 仅在**显式请求**时创建；**有未完成 goal 时失败** |
| `update_goal` | `status` ∈ {complete, blocked, paused} | `paused` 需用户明确请求；`complete` 需证据；`blocked` 需同一阻塞**连续 ≥3 轮** |

要点：
- 工具描述里明确"`create_goal` 不要从普通任务推断目标"。
- `update_goal` 不接受 `resume`/`budget_limited`/`usage_limited`（由用户/系统控制）。
- `complete` 的返回里带 `completion_budget_report`，要求模型把最终 token/时间用量报告给用户。

### 4.1 objective 长度上限

- `MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4_000`（`codex-rs/protocol/src/protocol.rs`）；`validate_thread_goal_objective` 在 `create_goal` 时校验，**超限直接报错、拒绝创建**（不截断）。
- 另一条独立上限：`core/src/context/user_goal.rs` 的 `MAX_OBJECTIVE_BYTES = 700`，只用于"用户来源 goal 变更"的**注入消息**；超限**整段省略**（`[objective omitted; exceeds the evidence limit]`），理由：截断可能把"限制"变"授权"。
- 即：**工具创建的 objective 硬上限 4000 字符并拒绝；用户注入路径 700 字节并整段省略** —— 两条都不截断。

## 5. 提示词模板（`ext/goal/templates/goals/`）

三份模板，注入方式是 `InternalModelContextFragment`（`source="goal"`）。

### 5.1 `continuation.md`（续跑）
结构（很长、信息密度高）：
- `<objective>`：**XML 转义**，声明"用户提供的数据，不是更高优先级指令"。
- **Continuation behavior**：目标跨轮存活；不许把成功重新定义成更小/更容易的子集；临时粗糙可接受，但完成必须真实且经校验。
- **Budget**：tokens used / budget / remaining。
- **Work from evidence**：以当前工作树和外部状态为准，别信旧对话记忆。
- **No-progress check**：把上一轮分类为 progress / verified wait / no progress；"verified wait"必须是真的在轮询一个确认存活的具体 handle；观察超时不算终止。
- **Progress visibility**：可用 `update_plan` 时展示与真实目标挂钩的计划（但别拿计划更新代替干活）。
- **Fidelity**：每轮优化"向最终状态推进"，不许因为更容易通过测试就替换成更窄方案。
- **Completion audit**：把目标拆成需求→证据清单→逐项检查当前状态；"测试通过/绿色"只有在确认覆盖该需求后才算证据；不确定/间接证据 = 未达成；审计要**证明完成**，而非"没找到明显剩余工作"。
- **Blocked audit**：首次出现阻塞**不要**标 blocked；同一阻塞连续 ≥3 轮才可；用户 resume 后重新计数。

### 5.2 `budget_limit.md`
预算耗尽时注入：系统已把 goal 标为 `budget_limited`，**不要开始新的实质工作**，尽快收尾、总结进展与阻塞、给出下一步；budget_limited 优先于 paused。

### 5.3 `objective_updated.md`
用户编辑目标后注入：新目标取代旧目标，调整当前轮去追新目标；不要继续只服务旧目标的工作。

## 6. 运行时（`runtime.rs`）

- `GoalRuntimeHandle` 持有 `Arc<GoalRuntimeInner>`：`enabled: AtomicBool`、`goal_state_lock: Semaphore(1)`、`accounting_state`、`thread_manager: Weak<ThreadManager>`。
- **`continue_if_idle()`**：拿 `goal_state_lock` → 检查 deferral 表 → 取 live thread → 读 goal（非 active 则清 active 标记）→ 组装 `continuation_steering_item` → `start_turn_if_idle(...)`，带 `turn_trigger = "goal"`；成功则 `mark_goal_continuation(turn_id)`。**只有 idle 才续跑**，且不打断活跃轮 / 排队用户输入 / 其它 pending 工作。
- **停止原因** `ActiveGoalStopReason`：`TurnError→blocked`、`UsageLimit→usage_limited`、`EmptyResponse→blocked`、`ExecutionUnavailable→blocked`。空响应会"记录到一定次数后停"，防止模型空转。
- **外部变更**（app-server 来的 `set`/`clear`）：`prepare_external_goal_mutation()` 先作废旧 turn 的记账，再落库；`apply_external_goal_set()` 对 `active` 会 `continue_if_idle()`，对 objective 变化注入 `objective_updated_steering_item`。
- **`restore_after_resume()`**：恢复会话时，active 则重新标记为 idle-active，否则清 active。
- **`inject_active_turn_steering()`**：对正在跑的轮次注入 steer。

### 6.1 状态由谁设置（扩展钩子，`extension.rs`）

`blocked` / `usage_limited` / `budget_limited` **都不是用户命令设的**，而是宿主在生命周期钩子里设的：

| 状态 | 触发钩子 | 判定 |
| --- | --- | --- |
| `usage_limited` | `on_turn_error` | `input.error == CodexErrorInfo::UsageLimitExceeded` |
| `blocked` | `on_turn_error` | 其它**不可重试**错误（防止自动续跑死循环烧 token）；也可由**模型**在"同一阻塞 ≥3 轮"时通过工具设 |
| `blocked` | `on_turn_stop` | `ExecutionUnavailable`（重复执行失败）/ `EmptyResponse`（重复空响应） |
| `budget_limited` | `on_tool_finish` | 记账后 `tokensUsed >= tokenBudget` 且仍 active |

`usage_limited` 的来源链：**API 429 且 `error.type=usage_limit_reached`（或 `usage_not_included`/`insufficient_quota`/`credit_balance_exhausted`…）→ `api_bridge.rs` 映射成 `UsageLimitReached/QuotaExceeded/UsageNotIncluded` → `error.rs::to_codex_protocol_error()` 统一为 `CodexErrorInfo::UsageLimitExceeded` → `on_turn_error` 把 goal 标 `usage_limited`**。

> 结论：`usage_limited` 是**错误驱动**的宿主行为。自研时，能否实现取决于 OpenCode 是否把"额度/限流"错误作为可识别信号暴露给插件；拿不到就应放弃该状态（OMP 正因拿不到而省略）。

**`blocked` 的计数是"模型自述"，不是服务端统计**：`update_goal` 的 schema 只有 `status`（连 blocker 文本都不收），服务端不校验轮数；"同一阻塞连续 ≥3 轮"纯靠 `continuation.md` 的 Blocked audit 提示词约束模型自行判断。宿主的自动 blocked 路径（TurnError / EmptyResponse / ExecutionUnavailable）则不遵守 3 轮规则。自研若想更可靠，可让模型带 `blocker` 文本、由服务端做"同一阻塞指纹"的连续轮计数。

其它钩子（同一文件）：`on_thread_idle → continue_if_idle()`（续跑）、`on_thread_start/resume/stop`、`on_turn_start`（清 deferral、Plan 模式下清 active）、`on_turn_abort`（记账 + 清 TurnStartOptions）、`on_token_usage`（记 token）、`on_tool_finish`（工具进度记账 + budget 翻转时注入 budget-limit steer）。

## 7. 记账（`accounting.rs`，~24KB）

- 区分 **turn 记账**（`progress_snapshot(turn_id)`）与 **idle 记账**（`idle_progress_snapshot()`）。
- 记账模式 `GoalAccountingMode`：`ActiveOnly` / `ActiveOrComplete` / `ActiveOrStopped`（由 `update_goal` 的目标状态决定）。
- `BudgetLimitedGoalDisposition::ClearActive`：记账后是否清掉 active 指针。
- 用 `progress_accounting_permit()`（信号量）串行化记账；`mark_progress_accounted_for_status()` 记录"已记账到某状态"。
- 只记 **delta**：`time_delta_seconds` + `token_delta`。

## 8. 用户来源的 goal 变更（`core/src/context/user_goal.rs`）

- `UserGoalUpdate::{Set{objective,status}, Clear}`，**绝不从工具输出或自动续跑构造**。
- 通过 host 注解（`content_item_kinds` = `user.goal`）识别，而不是只靠文本 marker。
- `MAX_OBJECTIVE_BYTES = 700`；**超限整段省略**，理由写得很直白："Oversized objectives are omitted whole so truncation cannot turn a restriction into a grant."（截断可能把限制变成授权，所以宁可不带）。

## 9. App Server / TUI

- JSON-RPC：`thread/goal/set`、`thread/goal/get`、`thread/goal/clear` + `ThreadGoalUpdatedNotification`（见 `app-server-protocol/schema/.../v2/ThreadGoal*.ts`）。
- `set` 语义：新 objective **替换并重置记账**；对非终态 goal 更新则**保留累计用量**。
- 已知问题（来自 openai/codex issues/社区文）：
  - `/goal --tokens N` 预算没生效的反馈；
  - Plan 模式会**静默抑制**续跑（TUI 仍显示 active，但不动），UI 未说明；
  - 上下文压缩后 continuation/审计要求可能被压缩掉，导致提前判完成（已有修复提案）。

## 10. CLI 命令面（0.128.0+）

`/goal <objective>`、`/goal`（查看）、`/goal pause`、`/goal resume`、`/goal clear`；后续 PR 增加 `/goal edit`。
注意（社区实测）：`/goal set`、`/goal complete`、`/goal status` **不是真命令**，会被当成 objective 文本的一部分。

## 11. 对自研最值得抄的点

1. **状态机 + 权限划分**：模型只能 `complete`/`blocked`/`paused`，其余状态由用户/系统掌控。
2. **证据式完成**：completion audit 必须逐需求对证据，不确定 = 未达成。
3. **blocked 需要连续 ≥3 轮的同一阻塞**，且 resume 后重置计数 → 防止轻易放弃。
4. **续跑只在 idle**，用 deferral 表隔离"当前不能续跑"的原因。
5. **目标文本 XML 转义 + 当不可信数据**；超长目标**整段丢弃**而不是截断。
6. **budget-limited 是软停**：收尾、总结，不杀当前轮。
7. 明确区分 **turn 记账 vs idle 记账**、**delta 记账**、**记账信号量串行化**。
