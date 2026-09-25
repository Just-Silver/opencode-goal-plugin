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

`commands` / `basic` / `block` / `budget` / `interrupt` / `continuation` / `background` / `conflict` / `truncate` / `kv-cleanup` / `reconcile` / `empty` / `compaction`。

## 6. 验收结果（2026-09-25，V1 收尾）

> 环境：opencode **v2.0.15**（`v2` 分支）、模型 `r4-coder/deepseek-v4.1-flash`（推理模型）。会话 `ses_f293a2cfeffetRUBDZBZFXH9Sy`。
> 全量：`bun test` = **187 pass / 0 fail**；`bunx tsc --noEmit` = **0 错**。

本次收尾**实际复跑**的场景：

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| `reconcile` | ✅ PASS | 直写孤儿 KV（`updatedAt` 超保护窗）→ `reload` → 孤儿被清、活记录保留 |
| `compaction` | ✅ PASS | `session.compact` → 收 `session.compaction.ended`、摘要非空、目标仍 `active` |
| `truncate` | ✅ PASS | objective **7997 字符**进 KV（模型未压缩原文） |
| `empty` | ❌ FAIL（预期，模型依赖） | `emptyStreak=0`：推理模型每轮必有活动 → 真机**不可复现**。逻辑由 `src/model/empty.test.ts` + `src/host/events.test.ts`（走真实 router）覆盖 |

其余场景（`commands` / `basic` / `block` / `budget` / `interrupt` / `continuation` / `conflict` / `kv-cleanup`）在 v1 开发期建立，并用于定位真实 bug（如 `kv-cleanup` 暴露两个 KV 残留根因、`continuation` 用于验证代际守卫的 `cont <= succeeded` 回归护栏）；**本次收尾未复跑**——发版前建议整包再跑一遍。

调试时间戳（第 7 项）：`clock()` 改本地墙钟 `HH:mm:ss.SSS`，由 `src/host/debug.ts` 的 `debug.test.ts`（非 UTC 断言）覆盖。

**发布（OIDC 真实发布）**：**2026-09-25 已发布 `0.1.1`** —— tag `v0.1.1` → CD 走 OIDC，npm `@justsilver/opencode-goal-plugin@0.1.1` 已上线（`latest = 0.1.1`、provenance 已签名并写入 sigstore 透明日志），GitHub Release `v0.1.1` 已建。

**npm 渠道升级验证**：`opencode plugin add` 已验证可用（从 registry 解析并安装 `0.1.0`）；`opencode plugin check` / `update` 的端到端验证受本机**共享 host server** 限制（CLI 复用已在跑的 server，读的是真实全局配置，临时 `OPENCODE_CONFIG_DIR` / `OPENCODE_TEST_HOME` 均无法隔离），**未完成**。该路径是宿主行为（本插件无任何相关代码），建议在干净环境（独立 HOME + 无在跑 server）补测。

## 7. 后台 deferral 真机验收（2026-09-25，V2 子项目 2）

> 会话 `ses_f28ab48e8ffez9TtXXRvmxubIc`（location `C:\Users\13178`），模型 `xiaomi/mimo-v2.6-flash`。

- `background` 场景 **PASS**（39.5s）：模型 `shell {background:true}` 起后台 `sleep 30`；**后台运行期间 auto-continue 回执 = 0**（defer 生效）；完成通知唤醒后目标收尾。
  - 注：该场景**不**硬断言「完成后必有 auto-continue」——模型可能在宿主唤醒轮里直接 `goal(complete)` 收尾（本次实测即如此），此时 0 条属正常。
- `background-subagent` 场景 **PASS**（42.6s）：模型 `subagent {agent:"general", background:true}` 起后台子代理；**运行期间 auto-continue 回执 = 0**（defer 生效）；完成通知唤醒后收尾。验证了子代理会新建子会话、其自身 `execution.*` 事件不干扰父会话 deferral。
- `continuation` 回归 **PASS**（15.3s）：`execution.succeeded=3`、auto-continue 回执 = 2 → `cont <= succeeded` 成立（代际护栏无回归）。
- **真机 metadata 形状核对**（spec §3.2 要求，防「假形状遮真 bug」）：
  - shell 起：`session.tool.success` 的 `data.metadata` = `{"status":"running","truncated":false,"shellID":"sh_…"}` ✓
  - shell 止：`{"source":"shell","shellID":"sh_…","jobID":"sh_…","state":"completed","truncated":false,"exit":0}`；文本 `<shell id="sh_…" state="completed" command="…">…</shell>` ✓
  - subagent 起：`{"sessionID":"ses_…","status":"running","truncated":false}` ✓
  - subagent 止：`{"source":"subagent","childID":"ses_…","agent":"General","state":"completed"}`；文本 `<subagent sessionID="ses_…" state="completed" …>…</subagent>` ✓
  - **key 对齐**：subagent 起 `sessionID` 与止 `childID` 同值；shell `jobID === shellID` → metadata 主路径与文本兜底的 key 均一致。

## 8. 宿主信号 → 状态真机验收（2026-09-25，V2 子项目 3）

> 会话 `ses_f28ab48e8ffez9TtXXRvmxubIc`（location `C:\Users\13178`）。一次性探针脚本（未提交）经 HTTP API 制造终态失败，用 SSE `/api/event` 抓 `session.execution.failed`。

- **事件送达 + 形状核对**（spec §3.2/§3.6）：
  - 把会话模型指向不存在路由 → `session.execution.failed` 的 `data.error = {"type":"provider.no-route","message":"Model unavailable: …"}`。**被排除**：目标状态未变、无回执 ✓
  - 临时加一个坏 API key 的 provider（`probe-bad`，用完已删）→ `data.error = {"type":"provider.auth","message":"Invalid or missing API key","status":401}`（**被映射**，形状含 `status`）✓
- **端到端（被映射路径）**：预置一个 active 目标 → `provider.auth` 失败后：
  - 回执 = `Goal marked blocked: Invalid or missing API key. Use /goal-resume after resolving it.` ✓
  - 目标记录 = `blocked`、`lastError.type = "provider.auth"` ✓
- **插件已加载**：`/goal-status` 正常返回回执（证明命令面在跑）。
- **订阅语义**：未直接测「插件重启不重放」；旁证——插件既有的 `session.execution.failed` 结算与 `session.deleted` 清理长期依赖「实时流、不重放」，冒烟回归稳定。spec §8 已记录该残留假设（若确认重放，再加事件时刻/序号护栏）。

## 9. i18n 真机验收（2026-09-25，V2 i18n）

> 会话 `ses_f28ab48e8ffez9TtXXRvmxubIc`（location `C:\Users\13178`，系统 locale `zh-CN`）。插件复原后经 HTTP API 发命令、SSE `/api/event` 抓 `session.inbox.enqueued` 的 `description`。

- **默认跟随系统 locale（未设 `language`）**：
  - `/goal-status` → `本会话未设置目标。`（中文）✓
  - `/goal-debug env` → `opencode-goal 调试 env\n实例 location：…\n会话：…\n会话目录：…\n是否属于本实例：是\n配置：{…}`（全中文标签）✓
- 结论：语言探测（`Intl` → `zh-CN`）与 `messages` 接线在真机生效。
- `language` 显式覆盖未单独真机测（单测已覆盖 `resolveOptions` 归一与 `resolveLanguage` 优先级）。

## 10. 自动续跑计数 + 预算随时可调真机验收（实现已完成；真机待跑，V2 子项目 6）

> 代码已在分支 `feat/v2-continuation-count-and-budget` 落地并通过单测；**真机验收尚未执行**，发布前按 spec §6 执行并在此补结论。

- `/goal-status` 显示「自动续跑 N 次」。
- 跨轮续跑 notice 依次 `目标自动续跑 #1` / `#2`…
- `token_budget=1` → `budget-limited` → `/goal-budget 500000`：状态回「进行中」，回执「预算已设为 500000；目标当前为「进行中」。」；再发一条消息后继续续跑。
- `/goal-budget none`：回执「已取消预算（不限）；…」；`/goal-status` 显示「无预算」。
- 对话式「预算加到 50 万」：模型调用 `goal(op="budget", token_budget=500000)`。
- 回归：`smoke-api.mjs --scenario budget` PASS；`--scenario continuation` 的 `cont <= succeeded` 仍成立。
