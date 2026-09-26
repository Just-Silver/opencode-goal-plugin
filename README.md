# opencode-goal-plugin

给 OpenCode V2 加**持久目标**：说一次目标，它记住、自己接着干，完成时拿证据说话。

## 安装

在 `opencode.json(c)` 的 `plugins` 里加一行。全局配置是 `~/.config/opencode/opencode.json`，也可以在项目根目录放 `opencode.json` / `opencode.jsonc`：

```jsonc
{
  "plugins": ["@justsilver/opencode-goal-plugin"]
}
```

带参数（可用键见[配置项](#配置项)）：

```jsonc
{
  "plugins": [
    {
      "package": "@justsilver/opencode-goal-plugin",
      "options": {
        "token_budget": 200000,
        "debug": false
      }
    }
  ]
}
```

- 要钉住版本（可复现，代价是不再显示有新版）：`"plugins": ["@justsilver/opencode-goal-plugin@0.2.0"]`
- 本地目录 / git 安装（改代码即热重载、用未发布的提交）见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 用法

在会话里输入：

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 设定目标；信息不够时它会先追问几个问题，够了再自动开始 |
| `/goal`（或 `/goal-status`） | 查看当前目标与进度 |
| `/goal-pause` | 暂停 |
| `/goal-resume` | 恢复并**立刻激活**（仅在会话空闲、且预算还够时；预算已用尽会**拒绝**并提示改用 `/goal-budget` 提高预算） |
| `/goal-clear` | 清除目标 |
| `/goal-budget <正整数\|none>` | 改当前目标的 token 预算（`none`/`0`/`off` 取消预算、不限）；把预算从「已用尽」改回可用时会**一并激活** |
| `/goal-rebuild <新目标>` | 重建当前目标的正文：只换目标内容，状态、预算与用量记账全保留（不会唤醒模型） |

> **回执显示**：**命令**结果以 **TUI toast 浮条**呈现（右上角、自动消失、不打断操作）——**不写入对话历史**，因此不消耗额外 token、也不污染模型上下文；只有你正看着该会话的窗口会提示。**目标停摆**（预算用尽 / 用量受限 / 受阻）改用会话内的**合成提示**（`session.synthetic`：模型与人都看得到、留在转录里），这类事件罕见且必须让人看到——代价是它会**唤醒一轮收尾**（让模型简短总结，而不是静默停住）。两者都**需要 OpenCode V2 的 TUI**（插件自带界面入口，随包自动加载，无需额外配置）；**无 TUI 时命令照常生效**，停摆提示仍写入会话。

设定后目标会在多轮之间持续：一轮结束、空闲时自动接着干，直到完成、暂停、受阻或超出预算。

- **完成要拿证据**：模型必须核对当前状态，才敢说「完成」。
- **受阻 / 预算 / 用量到达**时目标会停下并给出回执（**留在转录里**，不会像 toast 那样消失）：受阻 / 用量受限用 `/goal-resume` 恢复；**预算用尽**要先用 `/goal-budget` 提高预算（或 `none` 取消），否则 `/goal-resume` 会**拒绝**——因为恢复了下一轮末也会立刻再停。
- **恢复只在空闲时激活**：会话正在跑时不插队投递（否则会把续跑触发插进当前轮），改为本轮结束后自然续跑。
- **自动续跑有计数**：`/goal-status` 会显示「自动续跑 N 次」，每次续跑的回执带 `#N`。
- 界面文案**默认跟随系统语言**，可用配置项 `language` 切换。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token_budget` | 无 | 新目标的默认 token 预算 |
| `max_goal_token_budget` | 无 | 允许的最大预算 |
| `max_objective_chars` | 4000 | 目标注入提示词的截断阈值（超过仍保留全文，模型可完整取回） |
| `blocked_threshold` | 3 | 连续阻塞多少轮算「卡住」 |
| `empty_threshold` | 3 | 连续空转多少轮算「空转」 |
| `reconcile_guard_minutes` | 5 | 启动兜底保护窗（分钟） |
| `restricted_agents` | `["plan"]` | 受限 agent（拒创建 / 续跑 / resume） |
| `command_name` | `goal` | 主命令名；状态控制是派生命令 `<name>-status` / `-pause` / `-resume` / `-clear` |
| `debug_command_name` | `goal-debug` | 调试命令名 |
| `debug` | `true` | 注册只读调试工具 `goal_debug`（设 `false` 可让模型工具表保持干净） |
| `language` | 跟随系统 | 面向用户文案的语言，`"zh-CN"` 或 `"en"`（缺省用系统 locale 探测） |

---

源码与反馈：<https://github.com/Just-Silver/opencode-goal-plugin>
