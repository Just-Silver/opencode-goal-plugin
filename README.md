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

- 要钉住版本（可复现，代价是不再显示有新版）：`"plugins": ["@justsilver/opencode-goal-plugin@0.1.0"]`
- 本地目录 / git 安装（改代码即热重载、用未发布的提交）见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token_budget` | 无 | 新目标的默认 token 预算 |
| `max_goal_token_budget` | 无 | 允许的最大预算 |
| `max_objective_chars` | 4000 | 目标注入的截断阈值（全文始终存 KV） |
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
