# 开发与本地安装

面向改这个插件的人。**使用者**只需要看 `README.md`（安装 + 配置项）。

## 本地安装（改代码即热重载）

把本仓库放到配置文件旁边，然后在 `opencode.json(c)` 里指向它：

```jsonc
{
  "plugins": ["../opencode-goal-plugin"]
}
```

- 相对路径相对**配置文件所在目录**，必须以 `./` 或 `../` 开头；也支持绝对路径与 `file://`。
- 指向的必须是**目录**（指向文件会打印 `configured plugin path must be a directory` 并丢弃）。
- 改 `src/**` 会触发插件热重载（仅 mtime 变化也会）。

## 免配置（发现式加载）

把插件目录放进 `<配置目录>/plugins/`（或 `plugin/`），不用写 `plugins` 配置：

- 只扫**直接子项**，不递归；直接子**目录** = 目录插件。
- 直接子 `.ts` / `.js` 文件 = 文件插件；`.tsx` 不被发现。

布局与入口解析细节见 `docs/opencode/plugin-dev-gotchas.md` §3。

## git 安装

```jsonc
{
  "plugins": ["github:Just-Silver/opencode-goal-plugin#<40 位 commit SHA>"]
}
```

钉满 40 位 commit SHA 可复现且跳过解析；不钉版本会跟随默认分支，且 Windows 上解析时会 spawn `git ls-remote`（可能弹一下控制台窗口，见 `docs/opencode/known-issues.md`）。

## 开发

```bash
bun install
bun test            # 单测
bunx tsc --noEmit   # 类型检查
```

## 调试入口

`/goal-debug env|events|sessions|state`（人看）与 `goal_debug` 工具（agent 用）：只读、确定性、零 token，**不注入模型上下文**。

| 参数 | 看什么 |
| --- | --- |
| `env` | 本实例 location、目标会话所在目录、归属判定、生效的 `options` |
| `events` | 最近 50 条事件 + 归属判定（排查「没续跑 / 重复续跑」先看它） |
| `sessions` | 已存储的全部目标记录 |
| `state` | 本会话的内存轮状态 |

配置项 `debug: false` 可让 `goal_debug` 不出现在模型工具表里；`debug_command_name` 可改命令名。

## 发布

见 `docs/opencode/releasing.md`；发布前跑 `docs/opencode/smoke-checklist.md`。
