# opencode-goal V2 子项目 3 设计：宿主信号 → 状态

- 日期：2026-09-25
- 状态：**已实现（v0.2.0，2026-09-25）**
- 宿主：**OpenCode V2**（分支 `v2`，`@opencode/plugin@2.0.16`；宿主源码检出 `../Externals/opencode`）
- 上级：V2 里程碑（`1 发布收尾 → 2 后台 deferral → 3 signals → i18n → 5 TUI 侧边栏`；`4 跨会话列表` 已砍；已随 **v0.2.0** 发布）
- 相关：`docs/superpowers/specs/2026-09-24-opencode-goal-design.md`（v1，§9 宿主信号）、`docs/01-design-orientation.md` §4/§7、`docs/opencode/known-issues.md`、`docs/superpowers/specs/2026-09-25-opencode-goal-v2-background-deferral-design.md`

## 1. 背景与问题

本插件当前只对**成功**结束的轮做状态推进：`session.execution.succeeded` 时结算 + 续跑；`session.execution.failed` 时**只结算**（不续跑、**不因宿主错误改状态**——注意既有结算路径里的空转计数仍可能独立把 active 置 blocked，见 `model/empty.ts`）。因此，当一轮因**宿主终态错误**失败时：

- 目标仍停在 `active`；用户只看到宿主的报错，**不知道目标其实已经无法推进**；
- 用户下一条消息会让目标继续，若错误未解决会**再次失败**（不会跑飞，但没有「停」的语义）；
- 配额/限流（`provider.quota`）这类**外部可恢复**的停止，本该让目标进入一个明确、可 `/goal-resume` 的状态。

v1 设计（`2026-09-24-opencode-goal-design.md` §9）早已规划「宿主信号 → 状态」但**明确推迟**（`usage_limited`、不可重试错误 → `blocked`）。本子项目落地它。

## 2. 目标与非目标

**目标**：把宿主**终态失败**信号映射为 goal 状态：

- `provider.quota`（配额/限流，含 Go/Free/Black 用量上限）→ **`usage-limited`**；
- 一小组**确定性拒绝**类错误（`provider.auth` / `provider.content-filter` / `provider.invalid-request`）→ **`blocked`**。

并：记录 `lastError` 供展示、发一条纯回执告知用户、支持从新状态 `/goal-resume`。

**非目标（本子项目不做）**：

- **不加配置开关**（不做 `map_host_signals` 之类）；
- **不做自动恢复**（无法预知配额重置时刻；一律等用户 `/goal-resume`）；
- **不干预重试决策**（不实现 `retry` hook，不用它改 `decision`）；
- **不做 §9 旧表的全量映射**：`provider.no-route` / `provider.timeout` / `provider.unsupported-operation` 及**全部可重试类**（`rate-limit` / `internal` / `transport` / `invalid-output` / `unknown`）**不改状态**（理由见 §3.4/§3.5）；
- 不改记账口径、不改提示词注入结构、不落新 KV 前缀、不做 i18n、不做跨会话。

## 3. 宿主事实（已核实，2026-09-25）

### 3.1 V2 无 `session.error`；终态错误事件是 `session.execution.failed`

- `session.error` **只存在于 v1**（`packages/schema/src/v1/session.ts:652`）。V2 schema 中**没有**该事件。
- V2 的终态错误由 `session.execution.failed` 承载，`data.error` 为归一化后的 `SessionError.Error`：

  ```ts
  // packages/schema/src/session-event.ts:249
  export const Failed = Event.durable({ type: "session.execution.failed", ...options,
    schema: { ...Base, error: SessionError.Error } })
  // packages/schema/src/session-error.ts:7
  export const Error = Schema.Struct({ type: Schema.String, message: Schema.String, status?: Int })
  ```

- 发布路径：`packages/core/src/session/execution.ts` 的 `terminal(exit)`（line 51-57）对失败用 `toSessionError(failure)` 归一化后 `publish(Execution.Failed, { sessionID, error })`。**每个忙周期恰好一次终态观察**（源码注释）。

### 3.2 错误归一化分类（`packages/core/src/session/to-session-error.ts`）

| 宿主 `AIError.reason._tag` | 归一化 `error.type` |
| --- | --- |
| `QuotaExceeded` | `provider.quota` |
| `Authentication` | `provider.auth` |
| `ContentPolicy` | `provider.content-filter` |
| `InvalidRequest` | `provider.invalid-request` |
| `UnsupportedOperation` | `provider.unsupported-operation` |
| `NoRoute` | `provider.no-route` |
| `RateLimit` | `provider.rate-limit` |
| `ProviderInternal` | `provider.internal` |
| `Transport` | `provider.transport` |
| `InvalidProviderOutput` | `provider.invalid-output` |
| `UnknownProvider` | `provider.unknown` |
| `Timeout` | `provider.timeout` |
| 非 AIError | `permission.rejected` / `tool.execution` / `unknown` / `aborted` |

`ModelNotSelectedError` / `ModelUnavailableError` / `VariantUnavailableError` / `UnsupportedPackageError` / `ModelConfigurationError` / `ModelInitializationError` / `UnresolvedProviderVariablesError` **全部**归一化为 `provider.no-route`（`to-session-error.ts:55-64`）。

### 3.3 配额确实走终态（不会只重试）

- `packages/ai/src/provider-error.ts` 的 `classifyProviderFailure`：402、`insufficient_quota` / `usage_not_included` / `billing_error` / `gousagelimiterror` / `freeusagelimiterror` / `creditlimitexceeded`、或 429 且正文含 `usage limit` 等 → **`QuotaExceeded`**。Go/Free/Black 用量上限因此都归入 `provider.quota`。
- `packages/core/src/session/runner/retry.ts` 的 `isRetryable`：`QuotaExceeded` **返回 false** → `step.ts` 不重试 → `execution.ts` 发 `Failed`。
- V2 重试调度**有上限**（`runner/retry.ts` 的 `Schedule.recurs(10)`），与 v1 的「无限重试」不同（上游 #21960）。

**结论**：`error.type === "provider.quota"` 是 V2 上可靠、终态的配额信号。

### 3.4 为什么用**事件**而非 `retry` hook

`retry` hook（`ctx.session.hook("retry", …)`，官方文档 §Retry policy）确实能拿到 `event.error`，但它是**每次重试尝试**触发、且在**轮尚未终结**时触发；对可重试错误会**多次**进入。我们关心的是「这一轮**最终**失败了、原因是什么」——`session.execution.failed` 是唯一的终态事实，且携带同一份归一化 `error`。故**只用事件**，不用 hook、不改 `decision`。

### 3.5 `provider.no-route` 陷阱（必须排除）

`provider.no-route` 同时承载**真路由错误**与**已知宿主热重载 bug**产生的 `ModelUnavailableError`（`docs/opencode/known-issues.md`：热重载后模型注册表短暂失效 → `Failed to drain Session` + `ModelUnavailableError`）。若把它映射为 `blocked`，**每次插件热重载都会把目标卡成 blocked**。故**排除** `no-route`（以及同类的 `timeout` / `unsupported-operation`）。

### 3.6 待真机核对的假设

- 插件 `ctx.event.subscribe()` **只收实时事件、不重放历史 durable 事件**。若重放，插件重启时可能重放旧 `failed` 而误改状态。列为实施第一步真机核对项（见 §7）。
- `session.execution.failed` 的 `data.error` 运行时形状（`type` / `message` / `status`）与 §3.2 一致。

## 4. 设计

### 4.1 纯映射模块 `src/model/signals.ts`（新）

无宿主依赖、可单测：

```ts
export interface HostSignal {
  readonly status: "usage-limited" | "blocked"
  readonly type: string      // 原始 error.type
  readonly message: string
}

/** 校验 error 形状并映射；不映射的返回 undefined。 */
export function hostSignal(error: unknown): HostSignal | undefined

/** 状态转移：仅当 goal.status ∈ {active, blocked} 时改状态并记 lastError。 */
export function applyHostSignal(goal: Goal, now: number, signal: HostSignal): Goal
```

映射表：

| `error.type` | 结果 |
| --- | --- |
| `provider.quota` | `usage-limited` |
| `provider.auth` / `provider.content-filter` / `provider.invalid-request` | `blocked` |
| 其它一切（含 `no-route` / `timeout` / `unsupported-operation` / 全部可重试类 / 非 provider 错误） | `undefined` |

`hostSignal` 只接受 `type` 为非空字符串的对象；`message` 非字符串时按 `""` 处理。

### 4.2 状态与字段

- `GoalStatus` 增加 **`"usage-limited"`**（连字符，与 `budget-limited` 一致；v1 文档写作 `usage_limited` 属笔误，以本设计为准）。
- `Goal` 增加可选 **`lastError?: { type: string; message: string; at: number }`**。
  - 独立字段，**不复用** `blockerKey` / `blockerText` / `blockerStreak`——后者是「模型报障 + 服务端连续轮计数」机制，语义不同，混用会污染计数与 `goal(op="get")` 展示。
- `repository.decodeGoal`：对 `lastError` 做**与 `usage` 同风格**的可选校验——形状不对则**丢弃该字段、保留目标**（不因一个展示字段把记录判死）。

### 4.3 状态转移与优先级

`applyHostSignal(goal, now, signal)`：

```
若 goal.status 不在 {active, blocked} → 原样返回（paused / complete / usage-limited / budget-limited 不动）
否则 → { ...goal, status: signal.status, lastError: {type,message,at:now}, updatedAt: now }
```

**优先级（系统事实 > 模型主观）**：

- `budget-limited` **>** `usage-limited` **>** `blocked`。
- 相应地把 `model/limits.ts` 的 `applyBudget` 可升级来源由 `{active, blocked}` 扩为 **`{active, blocked, usage-limited}`**（预算命中仍可把 usage-limited 升级为 budget-limited）。
- 已在 `usage-limited` 时再来一个 host 信号：**不改**（避免状态抖动）；`active`/`blocked` 才接受信号。

### 4.4 事件接线（`src/host/events.ts`）

把 `session.execution.failed` 从 `session.execution.succeeded` 分支**拆出**：

1. **结算照旧**（仅当 `turnOpen`）：`turnOpen.delete` → `tracker.finish` → 记账 `accrue` → `applyTurn`（空转/blocker 归零）→ `resetBlockerStreak`。`failed` 仍**不续跑**。
2. **信号（无论 `turnOpen` 与否）**：从 `data.error` 取 `hostSignal(event.data.error)`；命中则 `save(sessionID, (goal, now) => applyHostSignal(goal, now, signal))`。
   - 不依赖 `turnOpen`：插件重启后接入时 `turnOpen` 为 false，但终态错误仍应改状态。
   - `save()` 内部会再跑 `applyBudget`（§4.3 的优先级在 `save` 里统一生效）。
3. **回执**：仅当**状态确实发生翻转**时，发一条纯回执 `notify`（`resume:false`）：
   - **判翻转的实现**：信号分支先 `load` 一次记下 `before.status`；`save` 后再 `load` 一次取**最终** `status`（`save` 内的 `applyBudget` 可能把它升级为 `budget-limited`）；两者不同才发。避免依赖 `save` 的中间态。
   - 文案按**最终** `status` 生成：
     - `usage-limited`：`Goal marked usage-limited: <message>. Use /goal-resume after the limit resets.`
     - `blocked`：`Goal marked blocked: <message>. Use /goal-resume after resolving it.`
   - `message` 为空时省略 `: <message>` 一段，避免出现 `marked blocked: .`。
   - 实现：给 `createEventRouter` 增加第三个参数 `notify`（`server.ts` 已有一个 `notify`，直接传入）。

### 4.5 展示

- `model/tool-result.ts` 的 `GoalView` 增加可选 `lastError`；`buildToolResult` 透传。
- `host/commands.ts` 的 `statusLine`：当 `lastError` 存在时追加 `; last error: <message || type>`。
- `server.ts` 的 `${name}-resume` 命令描述补 `usage-limited`（由「paused, blocked, or budget-limited」改为「paused, blocked, budget-limited, or usage-limited」）。

### 4.6 resume

- `model/goal.ts` 的 `resume()`：可恢复状态白名单加入 `usage-limited`；并在 resume 时清 `lastError`（与清 blocker 字段同一处，语义 =「恢复即新一轮」）。

### 4.7 debug

`/goal-debug state` 的会话快照**不新增字段**（`lastError` 已在 `/goal-status` 与 `goal(op="get")` 可见）。若真机核对需要，可临时用 `/goal-debug sessions` 看目标记录。

## 5. 与现有机制的关系

- **续跑触发**：`failed` 分支本就不续跑；本设计只在其上增加「改状态 + 回执」。`succeeded` 分支不动。
- **空转判定**（`model/empty.ts`）：只对 `active` 生效；状态翻成 usage-limited/blocked 后自然不再计空转。
- **记账**：`failed` 的结算路径不变（仍轮末一次性落账）。
- **blocker 机制**（`model/blocked.ts`）：不受影响；host-signal blocked 不写 `blocker*` 字段。
- **预算**（`model/limits.ts`）：`applyBudget` 升级来源扩展，优先级见 §4.3。
- **context 注入**（`host/hooks.ts`）：只在 `status === "active"` 注入；usage-limited/blocked 不注入，行为与 paused/blocked 一致。
- **后台 deferral**（子项目 2）：正交，不冲突。

## 6. 边界与不做

见 §2。补充：

- **同一失败不重复发回执**：只在 `status` 翻转时发；重复的 `failed`（理论上每忙周期一次）不会重复。
- **`provider.invalid-request` 含 context-overflow 的边界**：`toSessionError` 把 `InvalidRequest`（含 `classification: "context-overflow"`）统一归一化为 `provider.invalid-request`，`SessionError.Error` **无** `classification` 字段可区分。若一次 compaction 失败以该类型终结，会被判 `blocked`。可接受（确需用户介入），列为已知边界。
- **不映射可重试类的终态耗尽**：如 `rate-limit` 重试 10 次后仍失败 → `provider.rate-limit` → **不改状态**（视为瞬时）。目标保持 active，用户下次消息可继续。

## 7. 测试与验收

**实施第一步（先于写实现）**：真机核对 §3.6。方法：用可预期的终态错误（如把会话模型指向不存在的路由 → `provider.no-route`）触发一次 `session.execution.failed`，确认：

1. 插件确实收到该事件（`/goal-debug events` 里出现，且 decision = `allow`）；
2. 目标状态**未变**（no-route 被排除，验证排除逻辑与「事件确实到达」同时成立）；
3. 插件重启后不重放旧 `failed`（订阅为实时流）。

若可行，再用**无效 API key** 触发 `provider.auth`，确认状态翻为 `blocked` 且收到回执。

**单测**：

- `model/signals.test.ts`：映射表逐项（quota → usage-limited；auth/content-filter/invalid-request → blocked；no-route/timeout/unsupported/rate-limit/internal/transport/invalid-output/unknown/非对象 → undefined）；`applyHostSignal` 的「仅 active/blocked 接受」「记 lastError」「不改 blocker 字段」。
- `model/goal.test.ts`：从 `usage-limited` resume；resume 清 `lastError`。
- `model/limits.test.ts`：`usage-limited` 可被预算升级为 `budget-limited`。
- `host/events.test.ts`（真实 router）：quota 的 failed → `usage-limited` + 回执 + 不续跑；auth → `blocked` + 回执；rate-limit/unknown/no-route → 状态不变、无回执；非 active（paused/complete/budget-limited）→ 不变；**已在 `usage-limited` 再来一个 host 信号 → 不变、无回执**；`turnOpen=false` 时仍改状态；`failed` 仍结算记账。
- `host/commands.test.ts`：`statusLine` 展示 `lastError`。
- `store/repository.test.ts`：`lastError` 往返；畸形 `lastError` 被丢弃但目标保留。
- `model/tool-result.test.ts`（若存在）：`view` 透传 `lastError`。

**冒烟**：不新增场景（无法在冒烟里稳定制造终态错误）。`continuation` / `background` 回归保持。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 依赖 `session.execution.failed.data.error` 的非官方形状 | §7 实施第一步真机核对；识别不到 → 状态不变（宁可不改） |
| `provider.no-route` 误伤热重载 | **明确排除** no-route（§3.5） |
| 订阅若重放历史 durable 事件 → 重启误改状态 | §7 真机核对；若确认会重放，需加「事件时刻/序号」护栏（届时再定） |
| `provider.invalid-request` 误收 context-overflow | 已知边界（§6），可接受 |
| 与预算优先级冲突 | §4.3 明确 budget-limited > usage-limited > blocked |
| 状态抖动（usage-limited 时再来信号） | 已在 usage-limited 不再接受新信号（§4.3） |

## 9. 参考

- 官方插件文档（`services/www/src/docs/content/build/plugins/index.mdx`）：Hooks / Sessions / Retry policy；`ctx.session.hook("retry")` 契约、`ctx.event.subscribe()`。
- 宿主源码：`packages/core/src/session/execution.ts`、`runner/retry.ts`、`runner/step.ts`、`to-session-error.ts`、`packages/schema/src/session-event.ts`、`session-error.ts`、`packages/ai/src/provider-error.ts`、`schema/errors.ts`、`packages/plugin/src/promise/session.ts`、`core/src/plugin/hooks.ts`。
- 上游：anomalyco/opencode #21960（v1 无限重试）；生态插件（quota-failover / rate-limit-retry / oh-my-opencode-slim）均基于 v1 事件，对 V2 不适用。
- 本仓库：`docs/01-design-orientation.md` §4/§7、`docs/opencode/known-issues.md`（热重载 ModelUnavailableError）。

## 10. 修订记录

- **2026-09-25（初稿）**：经 docs / 宿主源码 / GitHub 三侧核实，确定 V2 唯一可靠终态错误信号为 `session.execution.failed.data.error`；映射范围定为 `provider.quota → usage-limited` + `{auth, content-filter, invalid-request} → blocked`；排除 `no-route`（热重载陷阱）等；不加配置、不做自动恢复、不干预重试。
- **2026-09-25（独立子代理审阅，Approved）**：并入 4 条改进：① §1 措辞更正（`failed` 路径并非绝对不改状态——空转计数仍可独立置 blocked）；② §4.4 点明「判翻转」的实现（前后各 load 一次、按最终 status 生成回执）；③ §7 补「已在 usage-limited 再来信号 → 不变、无回执」用例；④ 回执文案按最终 status（含 `applyBudget` 升级）。
- **2026-09-25（实现回填）**：§4.5 措辞与实现对齐为 `; last error: <message || type>`。
