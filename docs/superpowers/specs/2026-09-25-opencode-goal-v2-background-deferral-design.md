# opencode-goal V2 子项目 2 设计：后台任务 deferral

- 日期：2026-09-25
- 状态：**待审阅**
- 宿主：**OpenCode V2**（分支 `v2`，`@opencode/plugin@2.0.16`；宿主源码检出 `../Externals/opencode`）
- 上级：V2 里程碑（`1 发布收尾 → 2 后台 deferral → 3 signals → 5 TUI 侧边栏`；`4 跨会话列表` 与 `6 i18n` 已砍）
- 相关：`docs/superpowers/specs/2026-09-24-opencode-goal-design.md`（v1）、`docs/opencode/known-issues.md`、`docs/00-comparison.md`

## 1. 背景与问题

OpenCode V2 支持**后台任务**：工具入参 `background: true`（`shell` 与 `subagent` 都有）。后台任务运行期间，**主会话会照常发 `session.execution.succeeded`**：

- `packages/core/src/session/execution.ts` 的 `settled`：drain 一结束就发 `Execution.Succeeded`；`Job` 是 core 内部**独立**服务（`job.ts`，进程本地），后台 job **不阻塞** drain。
- 后台 shell/subagent 的 `execute` 返回 `status:"running"` 后本步即完成 → 模型结束本轮 → `execution.succeeded`。

本插件当前只认「`execution.succeeded` + 目标 `active`」→ **会立刻注入一轮 `Goal auto-continue`**。后果：抢跑 / 重复工作 / 额外 token，甚至可能在后台任务完成前就误判目标完成。

这与宿主自己的指引冲突。后台工具返回文本明确写着：

> DO NOT poll… end your response; **you will be resumed automatically when the command finishes**.

即宿主期望「结束本轮、等完成通知再醒」。本设计让插件遵守这个语义。

## 2. 目标与非目标

**目标**：本会话有后台任务在跑时，`execution.succeeded` **不**自动续跑；任务结束后恢复。

**非目标（本子项目不做）**：

- 不落 KV（纯内存；见 §4.1）；
- 不加配置项（不做 `defer_while_tasks_active` / `max_task_block_seconds`）；
- 不做「超时放行」安全阀；
- 不做「重启回放 transcript 重建」（列为后续可选项）；
- 不改目标状态机 / 记账 / 提示词 / KV 结构。

## 3. 宿主事实（已核实，2026-09-25）

### 3.1 插件侧**没有**任何后台任务查询接口

| 面 | 查了什么 | 结论 |
| --- | --- | --- |
| 插件 `Context` | 全字段（`packages/plugin/src/effect/plugin.ts`、node_modules `@opencode/plugin@2.0.16`） | 无 `job`/`background`/`subagent` 域 |
| `SessionDomain` | `Pick<SessionApi, …>` | 13 个方法（create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/context），**无 `list`/`active`** |
| `ShellDomain` | 接口 | **只有** `hook("create.before")`，无 `list`/`get` |
| `RpcDomain` | `RpcApi` + `register` | 只调插件自注册的 portable RPC；宿主**未注册**任何内置 RPC |
| 事件清单 | schema 全集（~110 个 type） | **无** `job.*` / `background.*` / `subagent.*` |
| `SessionHooks` | 名单 | prompt/context/compaction/generate/title/model.request/http.request/http.response/ws.*/retry —— 无 job/background |
| HTTP/OpenAPI | 全量 operation | **有** `shell.list`（列出该 location 正在运行的 shell）、`shell.get`、`session.active`（`{[sid]:{type:"running"}}`）——但**插件侧不可达** |

> `session.shell.started/ended` 是**用户 `!命令`** 路径（`packages/core/src/session/session.ts` 的 `Session.shell`），**不是** `shell` 工具的后台模式，本设计不用它。

### 3.2 可用的推断信号（事件 metadata，非官方契约）

**起（后台任务开始）** —— `session.tool.success` 的结果 metadata：

- 后台 **shell**：`{ status: "running", shellID: "sh_…", truncated }`
  出处：`packages/core/src/tool/plugin/shell.ts` 的 `toolResult`/`backgroundResult`。
- 后台 **subagent**：`{ sessionID: "ses_…"（子会话）, status: "running" }`
  出处：`packages/core/src/tool/plugin/subagent.ts:264`。
- 备选：子会话 `session.created` 带 `parentID`（schema：`packages/schema/src/session-event.ts` 的 `Created`，含 `parentID`），`sessionID` = 子会话。

**止（后台任务结束）** —— `session.synthetic` 完成通知的 metadata：

- shell：`{ source: "shell", shellID, jobID?, state, … }`
  出处：`packages/core/src/shell/result.ts` 的 `notification`；由 `tool/plugin/shell.ts` 的 `notifyWhenDone` 投递。
- subagent：`{ source: "subagent", childID, agent, state }`
  出处：`packages/core/src/session/subagent-completion.ts:42`。

**文本形状（兜底用）**：

- shell：`<shell id="…" state="completed|cancelled|error" command="…">…</shell>`
- subagent：`<subagent sessionID="…" state="…" description="…">…</subagent>`

**清理**：`session.execution.interrupted`、`session.deleted`。

### 3.3 宿主「完成即唤醒」是普遍保证（本设计的安全底座）

`packages/core/src/session/session.ts:311`：

```ts
if (input.resume !== false && !(yield* get(sessionID)).revert) yield* execution.wake(sessionID)
```

- shell `notifyWhenDone`、subagent `SubagentCompletion.deliver` 都**不传 `resume:false`**（仅「会话挂起」时显式传 false）→ 默认**唤醒**。
- 成功 / 失败 / 取消 / 超时**都会**投递通知并唤醒。

**含义**：插件只需负责「任务在跑时别插队」；任务一结束宿主**必然**把会话叫醒 → 通知事件到达 → 清 pending。因此**几乎不存在永久卡死**，不需要超时放行安全阀。

### 3.4 不会与宿主「抢」续跑

1. 我们只在 `execution.succeeded`（**轮末**）投递；宿主通知唤醒发生在**任务完成那一刻**，时序天然错开。
2. 有 pending 时我们**完全不动**，通知是那一轮唯一触发者。
3. 宿主 `execution.wake` 会**合并**重复唤醒（`execution.ts` 注释：Repeated wakeups may coalesce）→ 通知与我们的续跑若同时进 inbox，被同一次执行一起 drain，**一轮**而非两轮。
4. 已有回归护栏：冒烟断言 `auto-continue 回执数 <= execution.succeeded 轮数`；代际守卫卡「N 倍实例」。

## 4. 设计

改动集中在 `src/host/events.ts`（与现有 `Map/Set` 同风格），`src/host/debug.ts` 加只读展示。

### 4.1 状态：`pendingBackground`（内存）

每个会话一个 `Set<string>`（`Map<sessionID, Set<string>>`），key 为后台任务标识：

- 后台 shell：`shellID`（`sh_…`）
- 后台 subagent：子会话 `sessionID`（`ses_…`）

**不落 KV**。理由：这是运行期状态，与进程绑定；KV 只存目标记录。代价是插件热重载/重启会丢 pending（后续可选「回放 transcript 重建」，本子项目不做）。

### 4.2 起：加入 pending

处理 `session.tool.success`：

- 读结果 metadata。若 `status === "running"`：
  - 有 `shellID` → 加入该会话的 pending（key = `shellID`）；
  - 有 `sessionID` → 加入（key = `sessionID`）。
- 防御性分支：若 metadata 带 `background === true` 且存在 `shellID`/`sessionID` → 同样加入（当前工具结果**无**此字段；此分支只为宿主未来补标记时兜底）。
- 兜底：`session.created` 带 `parentID` → 把该事件 `sessionID`（子会话）作为 key，加入 **`parentID` 会话**的 pending（覆盖「工具结果事件缺失」）。注意：前台 subagent 结果 `status:"completed"` **不**加入；只有 `running` 才加。

> 只处理「属于本 location」的事件（沿用现有归属判定）。子会话在同一 location，判定天然通过。

### 4.3 止：移出 pending

处理 `session.synthetic`：

- 读 metadata `source`：
  - `"shell"` → 用 `shellID` 移除（工具路径下 `jobID` 与 `shellID` 同值）；找不到 key 则**清空该会话 pending**（兜底，防泄漏）。
  - `"subagent"` → 用 `childID` 移除；找不到则**清空该会话 pending**。
- 若 metadata 无 `source`（形状漂移）→ 用**通知文本形状**兜底识别（`<shell … state=` / `<subagent … state=`），命中则清空该会话 pending。

### 4.4 清理

- `session.execution.interrupted`：清空该会话 pending（中断后目标转 `paused`，续跑本就不触发；清空避免恢复时残留误判）。
- `session.deleted`：删除该会话 pending。

### 4.5 门控

在 `session.execution.succeeded` 分支的续跑前插入：

```
若该会话 pendingBackground 非空 → 跳过续跑（照常记账/状态结算），并在 debug 记为 defer。
```

不改变 `failed` 的处理（本就不续跑）。

### 4.6 debug

`/goal-debug state` 的会话快照（`DebugSessionState`）新增 `pendingBackground: number`（计数）；`/goal-debug events` 的 `TRACKED_TYPES` 增加 `session.tool.success`、`session.synthetic`，便于真机核对 metadata 形状。

## 5. 与现有机制的关系

- **续跑触发**（`src/host/events.ts` 的 `session.execution.succeeded` 分支）：仅在续跑前多一道 `pendingBackground` 门控，其余不变。
- **空转判定**（`src/model/empty.ts`）：被 defer 的轮**不计**空转（因为根本没投递自动续跑轮）。
- **代际守卫**（`src/host/generation.ts`）：不受影响。
- **记账**：不受影响（无论是否 defer，轮末照常落账）。

## 6. 边界与不做

见 §2。特别地：**不做超时放行**——依据 §3.3，宿主保证「完成即唤醒」，泄漏风险仅剩「metadata 形状漂移」，由 §4.3 的兜底覆盖。

## 7. 测试与验收

**实施第一步（先于写实现）**：把 `session.tool.success`、`session.synthetic` 加进 `TRACKED_TYPES`，真机核对 metadata 真实形状（本仓库栽过「假形状遮住真 bug」，见 `plugin-dev-gotchas.md §8.3`）。确认后再写实现。

**单测**（`src/host/events.test.ts`，走真实 router）：

1. 起（shell）→ `execution.succeeded` → **不**续跑；
2. 起（subagent）→ 完成通知（`source:"subagent"`）→ `execution.succeeded` → 续跑；
3. 通知 key 不匹配 → 清空 pending → 下一次 `succeeded` 续跑；
4. 无 `source` 的通知（文本兜底）→ 清空；
5. `execution.interrupted` / `session.deleted` → pending 清空；
6. 多任务：两个 pending，移出一个 → 仍**不**续跑；移出两个 → 续跑。

**冒烟**（`scripts/smoke-api.mjs` 新增 `background` 场景）：

起一个后台 shell（`sleep` 一段时间）→ 断言该轮后**没有** `Goal auto-continue` 回执 → 等后台完成通知 → 断言随后出现续跑。

**回归护栏**：`continuation` 场景的 `cont <= succeeded` 断言保持。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 依赖非官方 metadata（tool 结果 / synthetic 通知） | 先真机核对；识别不到「起」→ 照常续跑（宁可漏 defer）；识别不到「止」→ 文本兜底 + 清空 |
| metadata 形状漂移导致 pending 泄漏 → 不续跑 | 通知命中 `source`/文本时清空该会话 pending |
| 插件热重载丢失 pending | 已知限制；后续可选「回放 transcript 重建」（prevalentWare 做法） |
| 后台 shell 不限时且永不结束 → 一直不续跑 | 语义上正确（确有任务在跑）；用户可 `/goal-pause`。**按决定不加超时放行** |
| 与宿主完成通知重复投递 | §3.4；`cont <= succeeded` 护栏 |

## 9. 参考

- **prevalentWare/opencode-goal-plugin**（417★，唯一成熟 V2 实现）：内存 `TaskTracker`（`Map<taskID, TaskRecord>`，taskID = 子会话 ID），多信号（工具调用 + **输出文本解析** `<task id state>`、子会话 `session.created` 带 `parentID`、子会话 status busy/idle、`session.deleted`、重启回放 transcript），`hasBlockingTasks` 门控，`max_task_block_seconds`（默认 900）超时放行，`defer_while_tasks_active`（默认 true）。**注意：它只处理 `task`/`subagent`，完全未处理后台 shell**——本设计在 shell 上超过它，且用 metadata 而非文本解析，更稳。
- **Codex**：`thread_goal_continuation_deferrals` 表（「当前不该续跑」的显式数据），见 `docs/codex/README.md:44`。
- 宿主源码：`packages/core/src/session/execution.ts`、`packages/core/src/tool/plugin/shell.ts`、`packages/core/src/tool/plugin/subagent.ts`、`packages/core/src/session/subagent-completion.ts`、`packages/core/src/shell/result.ts`、`packages/schema/src/session-event.ts`。

## 10. 修订记录

- **2026-09-25**：初稿。经穷尽核对确认宿主**无**任何插件可达的后台任务 API/事件/钩子；依据宿主「完成即唤醒」保证，定为内存 pending + 事件 metadata 推断 + 文本兜底，不做配置项与超时放行。