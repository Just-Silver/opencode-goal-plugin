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
| `/goal-resume` | 恢复（含受阻 / 预算用尽 / 用量受限） |
| `/goal-clear` | 清除目标 |
| `/goal-budget <正整数\|none>` | 改当前目标的 token 预算（`none`/`0`/`off` 取消预算、不限） |
| `/goal-rebuild <新目标>` | 重建当前目标的正文：只换目标内容，状态、预算与用量记账全保留（不会唤醒模型） |

设定后目标会在多轮之间持续：一轮结束、空闲时自动接着干，直到完成、暂停、受阻或超出预算。

- **完成要拿证据**：模型必须核对当前状态，才敢说「完成」。
- **受阻 / 预算 / 用量到达**时目标会停下并给出回执，可用 `/goal-resume` 继续。
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
