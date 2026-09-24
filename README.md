# opencode-goal-plugin

给 OpenCode V2 加**持久目标**：说一次目标，它记住、自己接着干，完成时拿证据说话。

源码与反馈：<https://github.com/Just-Silver/opencode-goal-plugin> ｜ 面向 **OpenCode V2**

## 安装

在 `opencode.json(c)` 的 `plugins` 里加一行即可。全局配置是 `~/.config/opencode/opencode.json`，也可以在项目根目录放 `opencode.json` / `opencode.jsonc`：

```jsonc
{
  "plugins": ["@justsilver/opencode-goal-plugin"]
}
```

保存后 OpenCode 会自动重载；没生效就重载 / 重启一次。

要传参数就写完整形式（可用键见[配置项](#配置项)）：

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

> 钉版本、git、本地目录、免配置等其它方式见[其它安装方式](#其它安装方式)。

## 使用

对它说一句话：

```
/goal 修好登录页的报错，并跑通相关测试
```

模型会把目标结构化并落库；此后它空闲时**自己接着干**，直到完成、暂停、卡住或超出预算。

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 建目标；目标不够具体时先追问（一次一问，最多六个问题） |
| `/goal`、`/goal status` | 报告当前目标 |
| `/goal pause` / `/goal resume` / `/goal clear` | 暂停 / 继续 / 清空（服务端处理，不消耗 token） |

模型侧还有 `goal` 工具（`get` / `complete` / `pause` / `resume` / `clear` / `block`），用于让**模型**自己推进与收尾，一般不用手敲。

转录里只多一行：`/goal …` 显示 `Goal request · …`，每轮自动续跑显示 `Goal auto-continue · …`。

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

## 升级

- **不会自动更新**：不写版本时只是**安装时**取 `latest`，之后启动只复用本地缓存、不联网。
- **也不会提醒**：没有任何推送 —— 不主动查就永远不知道有没有新版。
- 要升级就主动跑：`opencode plugin update @justsilver/opencode-goal-plugin`
- 想先确认有没有新版，只能主动查这两处（仅显示 `current` / `update available`，别无其它）：
  - `opencode plugin check`
  - TUI 的 `/plugins` 面板（显示 `update available` 时可顺手在面板里升级）
- 钉了精确版本或 40 位 commit 后，OpenCode 会跳过更新检查（永远显示「最新」），换来完全可复现。

## 其它安装方式

| 方式 | 写法 | 何时用 |
| --- | --- | --- |
| **npm 包**（推荐） | `@justsilver/opencode-goal-plugin` | 绝大多数人 |
| npm 包 + 钉版本 | `@justsilver/opencode-goal-plugin@0.1.0` | 要完全可复现 |
| git + 钉 commit | `github:Just-Silver/opencode-goal-plugin#<40 位 commit SHA>` | 要用某个未发布的提交 |
| git，不钉版本 | `github:Just-Silver/opencode-goal-plugin` | 想跟 `main` 最新；Windows 上可能弹一下控制台窗口（见[已知问题](docs/opencode/known-issues.md)） |
| 本地目录 | `../opencode-goal-plugin` | 改代码即热重载（开发） |
| 免配置 | 目录放进 `<配置目录>/plugins/` | 不想写配置 |

**钉版本**：

```jsonc
{
  "plugins": ["@justsilver/opencode-goal-plugin@0.1.0"]
}
```

**git（钉 commit）**：

```jsonc
{
  "plugins": ["github:Just-Silver/opencode-goal-plugin#<40 位 commit SHA>"]
}
```

**本地目录**（相对路径相对**配置文件所在目录**，用 `./` 或 `../` 开头，也支持绝对路径与 `file://`）：

```jsonc
{
  "plugins": ["../opencode-goal-plugin"]
}
```

## 它是怎么工作的

- **目标持久化**：每个会话一个目标，存在宿主 KV 里，重启与跨轮次都不丢。
- **空闲自动续跑**：一轮结束且没有未完成的工具调用时，自动把模型叫回来接着干。
- **不刷屏**：目标本体只注入 system 提示（不进消息、不进转录），每轮只落一行 48 字符的触发语。
- **证据式完成**：`complete` 必须给出完成证据；完成 / 阻塞前强制复核目标全文。
- **护栏**：token 预算、连续阻塞、连续空转、受限 agent。

## 调试

`/goal-debug env|events|sessions|state`：只读、确定性、零 token，**不注入模型上下文**。

| 参数 | 看什么 |
| --- | --- |
| `env` | 本实例 location、目标会话所在目录、归属判定、生效的 `options` |
| `events` | 最近 50 条事件 + 归属判定（排查「没续跑 / 重复续跑」先看它） |
| `sessions` | 已存储的全部目标记录 |
| `state` | 本会话的内存轮状态 |

给 agent 的对应入口是 `goal_debug(op=...)`（只读，描述里明写 `DEBUG ONLY`）。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/01-design-orientation.md` | 设计取向：为什么这么设计 |
| `docs/opencode/plugin-dev-gotchas.md` | OpenCode 插件开发踩坑（事件、多 location、入口解析、KV 清理…） |
| `docs/opencode/known-issues.md` | 已知问题与上游问题跟踪 |
| `docs/opencode/releasing.md` | 发布流程与回滚 |
| `docs/opencode/smoke-checklist.md` | 真机手动验收清单 |

## 开发

```bash
bun install
bun test            # 单测
bunx tsc --noEmit   # 类型检查
```

设计稿与实现计划在 `docs/superpowers/specs/`。

## License

MIT
