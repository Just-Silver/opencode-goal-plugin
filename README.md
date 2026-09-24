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

其它写法：

```jsonc
{ "plugins": ["@justsilver/opencode-goal-plugin@0.1.0"] }
```

```jsonc
{ "plugins": ["github:Just-Silver/opencode-goal-plugin#<40 位 commit SHA>"] }
```

```jsonc
{ "plugins": ["../opencode-goal-plugin"] }
```

- 三条依次是：钉版本（可复现，代价是不再显示有新版）、用某个未发布的提交、本地目录（开发用，改代码即热重载）。
- 本地目录的相对路径相对**配置文件所在目录**（`./` 或 `../` 开头），也支持绝对路径与 `file://`。
- 也可以把插件目录放进 `<配置目录>/plugins/`（免配置）。

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
| `command_name` | `goal` | 主命令名 |
| `debug_command_name` | `goal-debug` | 调试命令名 |
| `debug` | `true` | 注册只读调试工具 `goal_debug`（设 `false` 可让模型工具表保持干净） |

---

源码与文档：<https://github.com/Just-Silver/opencode-goal-plugin>
