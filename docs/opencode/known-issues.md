# 已知问题 / TODO

> 只记**已定位、暂缓修复**的问题。每条要写清：现象 / 根因（含出处）/ 影响 / 建议修法 / 怎么验证。修完就删条目。

## 1. 删除会话后 goal 记录仍留在 KV（孤儿）

**现象**：在 TUI 里删除会话后，`/goal-debug sessions` 仍列出该会话的 goal 记录（状态可能是 `complete`）；而 `opencode session export <sid>` 已经报 `Session not found`。

**已定位的根因**：
- 我们**有**处理删除：`src/host/events.ts` 的 `case "session.deleted"` → `deps.repo.remove(sessionID)`，且该类型也登记在 `TRACKED_TYPES` 里。
- 但事件路由进 `switch` 之前先做**归属判定**：带顶层 `location` 的事件直接与本实例比较；不带 `location` 的回落到 `ctx.session.get({ sessionID })` 查会话目录（`belongsToThisLocation`）。
- `session.deleted` 的 schema 只有 `{ sessionID }`，**不带 location**（`packages/schema/src/session-event.ts`：`const Base = { sessionID }`，`Deleted = Event.durable({ type: "session.deleted", schema: Base })`）。
- 会话已删 ⇒ `ctx.session.get` 抛 404 ⇒ 回落得到 `undefined` ⇒ 判定「不属于本实例」⇒ **事件被丢弃**，`repo.remove` 永不执行。
- 加重因素：`ctx.storage` 是**全局**的（跨 location 共享）。只有本实例此前恰好缓存过该会话目录（`sessionLocations`）才会删掉；插件一重载缓存为空，于是**稳定复现**。

**影响**：KV 残留；`/goal-debug sessions` 出现脏记录。插件下次 `reconcile`（启动兜底）会清掉它，但有 `reconcile_guard_minutes` 保护窗（默认 5 分钟）且「探测失败不删」，所以不会立即生效。

**建议修法（待定）**：`session.deleted` 不该参与归属判定 —— 会话已不存在，归属没有意义，直接 `repo.remove(sessionID)` 即可（多个实例重复执行是幂等的）。实现上可把该 case 移到归属判定之前，或在判定里对 `session.deleted` 特判放行。

**怎么验证**：删一个带 goal 的会话 → `goal_debug(op="sessions")` 不再列出它；`/goal-debug events` 里那条 `session.deleted` 的 `decision` 应为 `allow`。
