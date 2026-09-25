# 真机验收清单（手动）

> 需要在具备 OpenCode V2 运行时与确定性模型的机器上人工执行；本仓库的 CI 不实际执行。
> **发布前至少跑一遍**（发版流程见 `releasing.md`）。

## 1. 基本流程

1. 按 README 的 `plugins` 配置装好插件并启动 OpenCode V2。
2. 发：`/goal 在仓库根目录创建一个 hello.txt，内容为 hello，然后用 ls 验证文件存在`。
3. 观察：模型把目标结构化 → 调 `goal(op="create")` → 完成工作后调 `goal(op="complete")` → 状态变 `complete`。
4. `/goal-status` 报告状态；`/goal-clear` 后 KV 记录消失（再 `/goal-status` 应报 “No goal”）。
5. 制造空转：`/goal` 一个当前无法推进的目标，确认连续 3 个自动续跑轮后状态变 `blocked`，且工具返回带收尾指令。
6. 跨轮续跑：设一个需要分批做的目标，确认**每轮只落一行 48 字符触发语**、目标本体不出现在转录里，且能跨多轮做完并 `complete`。

## 2. KV 清理（改动清理逻辑后必跑）

> 单测里编造的错误/事件形状曾把两个真 bug 全遮住（见 `plugin-dev-gotchas.md` §8.3），所以这几条**必须真机跑**。

1. **事件路径（删会话）**：建会话 → `/goal` 建目标 → **触发一次插件重载**（清空实例内存里的会话目录缓存）→ 删会话。断言：
   - KV 里该键消失；
   - `/goal-debug sessions` 不再列出它；
   - `/goal-debug events` 里那条 `session.deleted` 的 decision 是 `allow`（修复前是 `drop-unknown-session`）。
2. **reconcile 兜底（冷启动）**：留一条宿主侧已不存在的会话记录，重载 / 重启一次（记录 `updatedAt` 超过 `reconcile_guard_minutes`）后必须消失。

读宿主 KV 的注意点：**必须把 `opencode.db` 的 `-wal`（和 `-shm`）一起复制**再读，否则只读连接看不到新写入，会误判成「0 条记录」。

## 3. 启动兜底 reconcile（改动 reconcile 后必跑）

`scripts/smoke-api.mjs --scenario reconcile` 已自动化：

1. 先建一个**活记录**（本会话），确保不被误删；
2. 直接往宿主 KV 写一条「会话不存在」的**过期孤儿**（`updatedAt` 早于 `reconcile_guard_minutes`）；
3. `opencode reload` 触发插件 setup → reconcile；
4. 断言：孤儿消失、活记录保留。

> 为什么能直接写 KV：宿主 `ctx.storage` 就是 `kv` 表、**无内存缓存**（`packages/core/src/kv.ts`），reload 后新实例 `scan` 即见。

## 4. 空转 → blocked（依赖模型，真机不一定可复现）

- 判定（`src/model/empty.ts`）：只有**自动续跑轮**（`automatic=true`）且**零活动**（无非空文本、无推理、无工具调用）才计入 `emptyStreak`；连续 `empty_threshold`（默认 3）轮 → `blocked`。
- **推理模型必然每轮产出推理/文本 → 真机上永不空转**，`--scenario empty` 会 FAIL（这是模型不配合，不是插件问题）。
- 因此这条以自动化测试为准：`src/model/empty.test.ts` + `src/host/events.test.ts` 的「three consecutive empty automatic turns block the goal」（走真实 router）。
- 若确实要真机验证，需换一个**能返回空输出**的模型/variant。

## 5. 自动化场景一览（`scripts/smoke-api.mjs`）

`commands` / `basic` / `block` / `budget` / `interrupt` / `continuation` / `conflict` / `truncate` / `kv-cleanup` / `reconcile` / `empty`。
