# opencode-goal-plugin

给 OpenCode V2 加**持久目标**：说一次目标，它记住、自己接着干，完成时拿证据说话。

- npm 包：`@justsilver/opencode-goal-plugin`
- 源码：<https://github.com/Just-Silver/opencode-goal-plugin>
- 面向 OpenCode V2

## 快速开始

1. 在 `opencode.json(c)` 的 `plugins` 里加一行：

```jsonc
{
  "plugins": [
    { "package": "@justsilver/opencode-goal-plugin", "options": {} }
  ]
}
```

2. 重载 / 重启 OpenCode，然后对一个会话说：

```
/goal 修好登录页的报错，并跑通相关测试
```

模型会把目标结构化并落库；之后它空闲时**自己接着干**，直到完成、暂停、卡住或超出预算。

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 目标持久化 | 每个会话一个目标，存在宿主 KV 里；重启、跨轮次都不丢 |
| 空闲自动续跑 | 一轮结束且没有未完成的工具调用时，自动发一行「继续」把模型叫回来接着干 |
| 跨轮不刷屏 | 目标本体只注入 **system 提示**（不进消息、不进转录），每轮只落一行 48 字符的触发语 —— 聊得再久也不会把上下文撑爆 |
| 证据式完成 | `complete` 要给出完成证据；完成 / 阻塞前强制复核目标全文 |
| 护栏 | token 预算、连续阻塞、连续空转、受限 agent（默认 `plan` 不能建目标） |
| 只读调试 | `/goal-debug`（人看）与 `goal_debug` 工具（agent 用），确定性、零 token |

## 用法

| 命令 | 作用 |
| --- | --- |
| `/goal <目标>` | 目标够具体就直接建；不够具体先追问（一次一问，最多六个问题） |
| `/goal`、`/goal status` | 报告当前目标 |
| `/goal pause` / `/goal resume` / `/goal clear` | 暂停 / 继续 / 清空（服务端确定性处理，不消耗 token） |

模型侧还有 `goal` 工具（`get` / `complete` / `pause` / `resume` / `clear` / `block`）——用于让**模型**自己推进和收尾，一般不用手敲。

> 转录里的样子：`/goal <目标>` 与每轮自动续跑都只显示**一行**（`Goal request · …` / `Goal auto-continue · …`），命令回执同样是一行通知。

## 配置项（`options`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token_budget` | 无 | 新目标默认 token 预算 |
| `max_goal_token_budget` | 无 | 允许的最大预算 |
| `max_objective_chars` | 4000 | 目标注入截断阈值（全文始终存 KV） |
| `blocked_threshold` | 3 | blocker 连续轮阈值 |
| `empty_threshold` | 3 | 空转连续轮阈值 |
| `reconcile_guard_minutes` | 5 | 启动兜底保护窗 |
| `restricted_agents` | `["plan"]` | 受限 agent（拒创建/续跑/resume） |
| `command_name` | `goal` | 主命令名 |
| `debug_command_name` | `goal-debug` | 调试命令名（只读、零 token） |
| `debug` | `true` | 注册只读调试工具 `goal_debug`（设 `false` 可让模型工具表保持干净） |

## 其它安装方式

- **git 仓库**（想钉某个未发布的提交时用）：
  `{ "package": "github:Just-Silver/opencode-goal-plugin#<40 位 commit SHA>" }`
  —— 钉满 commit SHA 可复现；未钉版本的 git 源在 Windows 上冷启动可能弹一下控制台窗口（上游问题，见 `docs/opencode/known-issues.md`），**npm 方式没有这个问题**。
- **本地目录**（改代码即热重载，开发用）：
  `{ "package": "<本仓库路径>" }`

固定版本用 `@justsilver/opencode-goal-plugin@0.1.0`；升级用 `opencode plugin update @justsilver/opencode-goal-plugin`。
安装与入口解析的内部细节（缓存路径、`files` 过滤、两种入口的差别）见 `docs/opencode/plugin-dev-gotchas.md` §3。

## 调试

`/goal-debug env|events|sessions|state`：只读、确定性、零 token，**不注入模型上下文**。

- `env`：本实例 location、目标会话所在目录、归属判定、生效的 `options`
- `events`：最近 50 条事件 + 归属判定（排「没续跑 / 重复续跑」先看这列）
- `sessions`：已存储的全部目标记录 ｜ `state`：本会话内存轮状态

给 agent 的对应入口是 `goal_debug(op=...)`（只读，description 明写 `DEBUG ONLY`）；不想要它出现在模型工具表里就设 `debug: false`。

## 文档

| 文档 | 内容 |
| --- | --- |
| `docs/01-design-orientation.md` | 设计取向：为什么这么设计 |
| `docs/superpowers/specs/` | 设计稿与实现计划 |
| `docs/opencode/plugin-dev-gotchas.md` | 插件开发踩坑（事件、多 location、入口解析、KV 清理…） |
| `docs/opencode/known-issues.md` | 已知问题 + 上游问题跟踪 |
| `docs/opencode/releasing.md` | 发布流程（npm Trusted Publishing）与回滚 |
| `docs/opencode/smoke-checklist.md` | 真机手动验收清单（发布前跑） |

## 开发

```bash
bun install
bun test            # 单测
bunx tsc --noEmit   # 类型检查
```

## License

MIT
