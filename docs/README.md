# 资料库索引（goal-research / docs）

自研 OpenCode goal 插件的参考资料。采集日期 2026-09-24。

## 阅读顺序

1. **`01-design-orientation.md`** —— 自研取向（已定 / 待议），最贴近落地
2. **`00-comparison.md`** —— Codex / OMP / prevalentWare 三方对比 + 自研取向草案
3. **`codex/README.md`** —— Codex CLI `/goal` 设计笔记（源码级）
4. **`omp/README.md`** —— oh-my-pi (OMP) 原生 goal 设计笔记（源码级）
5. **`opencode/goal-plugins-landscape.md`** —— OpenCode 上现有 goal 插件（星标排序）
6. **`opencode/config-install.md`** —— OpenCode 插件「配置安装」方法学（我们的分发方式）
7. **`opencode/plugin-dev-gotchas.md`** —— **v2 插件开发踩坑记录（已验证）**；动插件前先读
8. **`pi-ecosystem/README.md`** —— pi 生态的 goal 插件全景

## 目录结构

```
docs/
  README.md                         # 本索引
  00-comparison.md                  # 三方对比 + 取向
  codex/
    README.md                       # Codex goal 设计笔记
    sources/codex-rs/...            # Codex 原始源码归档（ext/goal、templates、state、tui…）
  omp/
    README.md                       # OMP goal 设计笔记
    sources/packages/coding-agent/  # OMP 原始源码归档（goals/、prompts/goals/、tui）
  opencode/
    config-install.md               # 配置安装方法学（自研汇总）
    goal-plugins-landscape.md       # OpenCode goal 插件现状
    plugin-dev-gotchas.md           # v2 插件开发踩坑记录（已验证）
  pi-ecosystem/
    README.md                       # pi goal 插件生态
  articles/                         # 网页/文章类素材（待补）
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

## 待补素材（TODO）
- `articles/`：Codex `/goal` 官方 use-case / cookbook / 第三方解读（链接与摘录）
- OMP 的 goal 测试文件（`test/goals/*`、`agent-session-goal-midrun-compaction`）
- Codex 的 `accounting.rs` 记账模型细节（已归档，未逐行笔记）
- `hsh` 其它 V2 插件（beremaran / phall1 / jadmadi）的源码抽样对比
