# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-09-25

首个公开发布。

### Added

- **`/goal` 命令**：一次一问地引导出目标，自适应创建持久目标（可带 token 预算）。
- **`goal` 工具**：`get` / `complete` / `pause` / `resume` / `clear` / `block` 等操作；工具直连注册（不进 Code Mode 目录）。
- **空闲自动续跑**：一轮结束且无未完成工具调用时，自动发一行触发语唤醒模型继续，直到目标完成、暂停、阻塞或超出预算。
- **目标上下文注入**：目标本体（objective + 状态 + 预算 + 全部行为规则）经 `session.hook("context")` 追加到 **system** 部分，只存在于当次请求、不落消息、不进转录；每轮只落一行 48 字符的续跑触发语。
- **证据式完成**：`complete` 需要给出完成证据；完成 / 阻塞前强制复核目标全文。
- **护栏**：token 预算（`token_budget` / `max_goal_token_budget`）、连续阻塞阈值（`blocked_threshold`）、空转阈值（`empty_threshold`）、受限 agent（`restricted_agents`）、目标注入截断（`max_objective_chars`）。
- **持久化**：per-session 存储于宿主 KV（`goal:<sessionID>`）；多 location 下按事件归属判定互不干扰。
- **启动兜底 reconcile**：清理宿主侧已不存在的会话残留记录（带 `reconcile_guard_minutes` 保护窗，默认 5 分钟）。
- **`/goal-debug` 命令与 `goal_debug` 工具**：`env` / `events` / `sessions` / `state` 四条诊断通道（纯文本输出）。

### Fixed

- **删除会话后目标记录残留**：`session.deleted` 的事件 payload 不带 `location`，原先会被归属判定判成「不属于本实例」而丢弃，清理从不执行；现豁免删除事件的归属判定（`remove` 幂等，多实例重复执行无害）。
- **reconcile 冷启动清不掉孤儿记录**：插件侧 `ctx.session.get` 抛的是 `Schema.TaggedError`（`Session.NotFoundError`，**没有 `status` 字段**），原先只认 `status === 404`，因此永远判不出「会话不存在」；现改认 `_tag`，其余错误一律保守跳过（宁可留，不可误删）。

### Security

- 插件自身**不 spawn 任何子进程**（无 `child_process` / `spawn` / `exec` / `fork`）。
- **无第三方运行时依赖**：运行时只 import 相对路径模块与宿主提供的类型。
