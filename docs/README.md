# 文档索引（docs/）

本仓库的文档分四类：**参考研究**（三方对比 + Codex/OMP/OpenCode 源码归档）、**自研规格与计划**（`superpowers/`）、**运维**（`opencode/`）、**取向与对比**（根级）。

## 想用插件

看仓库根 `README.md`（安装 + 配置项）。

## 想了解设计

1. **`01-design-orientation.md`** —— 自研取向（已定 / 待议 + **实现状态**），最贴近落地
2. **`00-comparison.md`** —— Codex / OMP / prevalentWare 三方对比 + 取向草案
3. **`codex/README.md`** —— Codex CLI `/goal` 设计笔记（源码级）
4. **`omp/README.md`** —— oh-my-pi (OMP) 原生 goal 设计笔记（源码级）
5. **`opencode/goal-plugins-landscape.md`** —— OpenCode 上现有 goal 插件（星标排序）
6. **`pi-ecosystem/README.md`** —— pi 生态的 goal 插件全景

## 想改插件

- **`opencode/plugin-dev-gotchas.md`** —— **v2 插件开发踩坑记录（已验证）**；动插件前先读
- **`opencode/config-install.md`** —— OpenCode 插件「配置安装」方法学（分发方式）
- **`opencode/known-issues.md`** —— 上游问题跟踪 + 已知坑
- 仓库根 `CONTRIBUTING.md` —— 本地安装 / 开发 / 真机冒烟

## 想发布

- **`opencode/releasing.md`** —— npm + GitHub Release 流程（版本单一来源、OIDC、回滚）
- **`opencode/smoke-checklist.md`** —— 发布前真机验收清单

## 实现规格与计划（`superpowers/`）

- `superpowers/specs/2026-09-24-opencode-goal-design.md` —— **v1 设计**（已实现）
- `superpowers/specs/2026-09-25-opencode-goal-v2-*-design.md` —— **V2 子项目**：后台 deferral / 宿主信号 / i18n（均已实现，v0.2.0）
- `superpowers/plans/2026-09-25-*.md` —— 对应实现计划（逐任务 TDD）

## 目录结构

```
docs/
  README.md                         # 本索引
  00-comparison.md                  # 三方对比 + 取向
  01-design-orientation.md          # 自研取向（含实现状态）
  codex/
    README.md                       # Codex goal 设计笔记
    sources/codex-rs/...            # Codex 原始源码归档（ext/goal、templates、state、tui…）
  omp/
    README.md                       # OMP goal 设计笔记
    sources/packages/...            # OMP 原始源码归档（goals/、prompts/goals/、tui）
  opencode/
    config-install.md               # 配置安装方法学（自研汇总）
    goal-plugins-landscape.md       # OpenCode goal 插件现状
    plugin-dev-gotchas.md           # v2 插件开发踩坑记录（已验证）
    known-issues.md                 # 上游问题跟踪 + 已知坑
    releasing.md                    # 发布流程
    smoke-checklist.md              # 发布前真机验收清单
    sources/packages/...            # 宿主源码归档（按需引用）
  pi-ecosystem/
    README.md                       # pi goal 插件生态
  superpowers/
    specs/                          # 自研设计规格（v1 + V2 子项目）
    plans/                          # 对应实现计划
```

## 原始源码归档清单

### Codex（`openai/codex` → `codex-rs/`）
- `ext/goal/src/`：`spec.rs`（工具定义）、`runtime.rs`（续跑/停止/外部变更）、`steering.rs`（模板渲染）、`tool.rs`（工具执行）、`accounting.rs`（记账）、`api.rs`、`events.rs`、`extension.rs`、`lib.rs`、`analytics.rs`、`metrics.rs`
- `ext/goal/templates/goals/`：`continuation.md`、`budget_limit.md`、`objective_updated.md`
- `state/goals_migrations/`：`0001_thread_goals.sql`、`0002_thread_goal_continuation_deferrals.sql`
- `app-server-protocol/schema/typescript/v2/`：`ThreadGoal.ts`、`ThreadGoalStatus.ts`
- `core/src/context/user_goal.rs`、`tui/src/app/thread_goal_actions.rs`、`tui/src/chatwidget/goal_status.rs`

### OMP（`can1357/oh-my-pi`）
- `packages/coding-agent/src/goals/`：`index.ts`、`runtime.ts`、`state.ts`、`tools/goal-tool.ts`
- `packages/coding-agent/src/prompts/goals/`：`goal-mode-active.md`、`goal-continuation.md`、`goal-budget-limit.md`、`goal-mode-context.md`、`goal-todo-context.md`、`guided-goal-interview.md`
- `packages/coding-agent/src/prompts/tools/goal.md`
- `packages/tui/src/tools/goal.ts`

### OpenCode（宿主 `v2` 分支）
- `packages/plugin/src/`：`host.ts`、`v2/{promise,effect}/*`（命令/事件/会话/上下文 API）
- `packages/core/src/`：`config/plugin/source.ts`、`plugin/{module,source-directory}.ts`、`session/*`、`agent.ts`、`event.ts`
- `packages/schema/src/`：`session-event.ts`、`server-event.ts`、`session.ts`、`event-manifest.ts`
- `packages/{llm,opencode}/src/`：provider 错误分类、重试、路由
- `packages/web/src/content/docs/{plugins,agents}.mdx`：官方插件/agent 文档
