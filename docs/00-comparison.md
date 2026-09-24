# 三方对比：Codex / OMP / prevalentWare(OpenCode) —— 与自研取向

> 输入：`docs/codex/`、`docs/omp/`、`docs/opencode/goal-plugins-landscape.md`。
> 目的：为「自研 OpenCode goal 插件」定取向。采集日期 2026-09-24。

## 1. 总览

| 维度 | Codex CLI | OMP (oh-my-pi) | prevalentWare (OpenCode) |
|---|---|---|---|
| 实现语言 | Rust（`ext/goal` crate） | TypeScript（原生内置） | TypeScript（第三方插件） |
| 目标作用域 | 线程 thread | 会话 session | 会话 session |
| 持久化 | SQLite（thread_goals + deferrals 表） | session 持久化（mode/state） | JSON 文件（原子写 + 校验/隔离） |
| 模型工具 | `get_goal` / `create_goal` / `update_goal`（3 个） | 单一 `goal` + `op` 枚举 | 9 个工具（get/create/set/update/update_status/update_objective/clear/list_all/history） |
| 状态机 | active/paused/blocked/usage_limited/budget_limited/complete | active/paused/budget-limited/complete/dropped | active/paused/budgetLimited/usageLimited/complete/unmet |
| 用户命令 | `/goal [pause/resume/clear/edit]` | `goal` 工具 + `/guided-goal` | `/goal` + `/pause_goal` + `/resume_goal` |
| 完成判定 | 证据审计（模板强制） | 证据审计（6 条，模板强制） | evidence/blocker + 审计提示 |
| blocked 门槛 | 同一阻塞连续 ≥3 轮 | 无 blocked（pause 表达） | 有 unmet（需具体 blocker） |
| 续跑触发 | idle + deferral 表门控 | agent_end + 隐藏 steer | idle/watchdog + task deferral |
| 记账 | delta + turn/idle 两种快照 + 信号量 | delta（input+cacheWrite+output）+ promise 链 | token 估算回退 |
| 隐藏提示注入 | InternalModelContextFragment(source="goal") | hidden message（customType, deliverAs steer） | system reminder 合并 + continuation prompt |
| 缺失/痛点 | Plan 模式静默抑制；压缩后丢审计 | （原生，较完整） | 单文件臃肿、V1/V2 重复、绑 beta |

## 2. 各家长处（取其所长）

**Codex**
- 权限划分最清晰：模型只能 `complete/blocked/paused`，`resume/budget_limited/usage_limited` 归用户或系统。
- `blocked` 需**同一阻塞连续 ≥3 轮**、resume 后重置 —— 防轻易放弃。
- deferral 表把"当前为何不续跑"变成数据。
- 超长目标**整段省略**（不截断，避免"截断把限制变授权"）。
- 明确 `continuation` / `budget_limit` / `objective_updated` 三模板分离。

**OMP**
- 单 `goal` 工具 + `op`：省 context、strict schema。
- 记账细节最贴近真实计费：**含 cacheWrite、排除 cacheRead**；记账串行化；落盘节流。
- 中断 → 暂停；会话恢复默认不自动续跑。
- **todo 当活状态注入**；`/guided-goal` 5 要素访谈保证目标可验证。
- 隐藏 steer（`deliverAs:"steer"`）+ `budgetReportedFor` 幂等。

**prevalentWare**
- 崩溃一致性（原子写/隔离/目录 fsync）与续跑竞态治理最硬。
- Plan 模式多层防护；命令参数/目标都当不可信数据。
- 测试与 CI 最完整（含 V2 真机 smoke）。

## 3. 我们要避免的

1. 单文件巨型化、V1/V2 逻辑重复 → **按职责拆模块，单一入口适配**。
2. 深绑某个 beta build → **把宿主差异收敛到一层 adapter**，上层不感知。
3. 命令语义依赖模型解析 → 子命令尽量**服务端确定性解析**（能确定就别丢给模型）。
4. 默认就自动续跑 → **默认保守，显式开启/首轮确认**。
5. 目标文本不设长度策略 → 采用 Codex 的"超长整段省略"。

## 4. 自研取向草案（待讨论）

- **范围**：OpenCode **server 侧插件**（命令 + 工具 + 续跑 + 持久化）；TUI 侧边栏可作为后续可选项。
- **安装方式**：**配置安装**（`opencode.json(c)` 的 `plugins`）。server 侧插件不受"双 Solid"限制，可直接配置安装 → 详见 `docs/opencode/config-install.md`。
- **工具面**：倾向 **OMP 式单工具 + `op`**（`create|get|complete|resume|drop`），或保留 `get/create/update` 三工具，二者择一并固定。
- **状态机**：`active | paused | blocked | budget-limited | complete | clear`；模型只能 `complete/blocked/paused`，其余归用户/系统。
- **持久化**：JSON 文件 + 原子写（复用 prevalentWare 的崩溃一致性经验，但独立实现）；按 session 键控；超长目标整段省略。
- **续跑**：idle 触发；deferral（子会话/工具在跑时不续）；中断 → 暂停；会话恢复默认不自动续。
- **提示词**：continuation / budget-limit / active 三份；强制"完成审计 + 不许重定义成功 + 预算≠完成 + 同一阻塞≥3 轮才 blocked"。
- **记账**：delta 记账；token 计数含 cacheWrite、排除 cacheRead（面向 Anthropic 系）；记账串行化 + 落盘节流。
- **验证**：`opencode2 api --standalone --print-logs GET /api/plugin` 看 stderr；隔离 `OPENCODE_*_STATE_PATH` 做 smoke。

> 以上是**取向草案**，不是最终设计；下一步进入需求/设计讨论。
