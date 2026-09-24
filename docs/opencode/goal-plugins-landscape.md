# OpenCode Goal 插件现状（星标排序）

> 采集日期 2026-09-24，数据来自 `gh search repos` + 各仓库 README。星标会变。

## 1. 支持 OpenCode V2 的（按星）

| 星 | 仓库 | V2 | 特点 |
|---:|---|---|---|
| **416** | `prevalentWare/opencode-goal-plugin` | ✅ 明确 | 唯一高星 V2；V1+V2 双入口；pin `beta-19425`（README 有 OpenCode 2 Beta 章节） |
| 1 | `wejick/opencode-goal` | ✅ | 要求 `0.0.0-beta-17898+`，基于 `code-yeongyu/pi-goal` |
| 0 | `phall1/opencode-goal-mode` | ✅ | "built for current OpenCode 2 plugin API"，pin `beta-19059`，只用新 add-only command transform |
| 0 | `beremaran/opencode-goal` | ✅ | 要求 2.0.0+；**独立 evaluator** 验证；自述 V2 API 限制（无法删 evaluator session） |
| 0 | `jadmadi/opencode-goal` | ✅ | "judged stop condition"，实测 v2.0.3 |
| 0 | `crazyCrabs/opencode-goal` | ✅ | "v2 plugin API"（同作者 `crazyCrabs/opencode_goal` 已归档） |
| 0 | `sblattj/opencode-goal-pro-max-complete-plugin` | ✅ 声称 | engines `>=1.17.15 <3`，含 sidebar、spend budget |
| 1 | `kartikkabadi/opencode-goal-loop` | 未声明 | `/goal` + `/loop` |

npm 侧另有 `opencode2-goal-plugin`（v1.0.5，无 TUI，V2 向），未搜到同名 GitHub 主仓。

## 2. 仅 V1 / 未声明 V2（按星）

| 星 | 仓库 | 备注 |
|---:|---|---|
| 264 | `william-ricchiuti/OpenCode-goal-plugin` | **明确不支持 V2**（engine pin `>=1.17.15 <2`）；V1 里工程最重：lease/shard 锁、独立 verifier、多目标/序列、审计 |
| 25 | `heimoshuiyu/opencode-goal-plugin` | V1；独立 `goal-verify` 子代理；状态存 SQLite `Session.metadata` |
| 18 | `watzon/opencode-goal` | 未提及 V2 |
| 9 | `mirsella/opencode-goal` | V1；用 experimental message transform hook |
| 7 | `yashverma2110/opencode-goalkit` | 未提及 V2 |
| 4 | `ByBrawe/opencode-goal` | V1 风格；host-verified、Goal 契约/队列/历史，命令极多 |
| 0 | `KairosOps/opencode-goal-mode` | "严格 Goal Mode + goal-guard 拦破坏性命令 + review gate"（和 `devinoldenburg/opencode-goal-mode` 描述一致，疑似改名） |

## 3. 生态观察

- **高星全在 V1**；V2 因 API 不稳，实现普遍是 0–1★ 的新仓库，且各自 pin 的 build 号不同 → 用 V2 插件必须与 `opencode2` build 对齐。
- **fork 链明显**：`paumkim/term-goal-plugin`（prevalentWare 的 fork）、`cioinside/opencode-goal-ext`（`opencode-goal-plugin` 的 fork）。
- 搜索命中几十个 0★ 同质仓库，可忽略。

## 4. `prevalentWare/opencode-goal-plugin` 评价摘要

（详见最初的设计评审，要点如下）

**优点**
- 分层清晰：`server.ts`（hooks/命令/工具/续跑协调）、`state.ts`（持久化+生命周期）、`atomic-write.ts`（崩溃一致性）、`prompts.ts`、`i18n.ts`、`tui.ts`。
- 持久化做得很硬：`open(tmp,"wx",0o600) → write → fsync → rename(Windows EPERM/EACCES/EBUSY 有界重试) → chmod 0600 → fsync 目录`；损坏状态**隔离**而非覆盖；区分"平台不支持目录 fsync"与真 I/O 失败。
- 续跑竞态治理细：`pendingAttempt` 投递前先持久化、`activeContinuations` 去重、区分 transport 失败与 abort/interrupt、no-progress 只对"保留的续跑轮"计数、Task 子会话阻塞 + 上限兜底。
- Plan 模式安全：多层拦截（创建即 paused、idle 不续、resume 被拒、prompt 固定 agent），默认 `allow_goal_execution_from_plan=false`。
- 注入意识：目标/证据/命令参数当不可信数据，XML 包裹 + 转义。
- 测试体量大：`server.test.ts` ~3.6k 行、`server-v2.test.ts` 独立 mock 事件流、`atomic-write.test.ts` 注入式失败测试、`smoke:v2` 起真实私有 server。

**代价 / 风险**
- `server.ts` 单文件 ~2900 行，并发状态（busy/watchdog/pending/failure/deferral）密集，缺统一状态图。
- V1 / V2 两套逻辑重复（watchdog、taskBlockStatus、continuation 调度各一份）。
- 绑定 beta 契约：`session.execution.succeeded`、`session.compaction` 等预览 API，用 `try/catch + 类型强转` 防御性注册。
- 子会话恢复靠回放 transcript（V2 无查活跃子会话的接口）。
- 命令解析是"模板 + 让模型按 `$ARGUMENTS` 解析"，非服务端确定性解析。
- 默认 `auto_continue: true` 偏激进。

## 5. 关键结论（对本项目）

1. **OpenCode 上没有"像 Codex/OMP 那样原生"的 goal**，全是第三方插件；prevalentWare 是唯一成熟且支持 V2 的。
2. 但 prevalentWare **复杂度偏高、双版本重复、绑 beta**，有不少可简化的空间。
3. 我们要做的是 **server 侧插件** → 可直接用**配置安装**（见 `docs/opencode/config-install.md`），不必发 npm、不必写安装脚本。
