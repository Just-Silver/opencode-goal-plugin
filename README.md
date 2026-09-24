# opencode-goal

Codex/OMP 风格的持久目标能力，用于 OpenCode V2：`/goal` 命令 + `goal` 工具 + 空闲续跑 + 证据式完成 + blocked/预算护栏。

## 安装（配置安装）

在 `opencode.json(c)` 加入：

```jsonc
{
  "plugins": [
    { "package": "github:Just-Silver/opencode-goal#<ref>", "options": {} }
  ]
}
```

`<ref>` 可为分支、tag 或 commit SHA。**推荐 pin 到 40 位 commit SHA**：宿主把 commit 视为不可变目标（不反复检查更新），分支/tag 视为可变目标（会定期查新）。

`package` 支持所有 `npm-package-arg` 认可的 git 形态：

- `github:Just-Silver/opencode-goal#<ref>`
- `git+https://github.com/Just-Silver/opencode-goal.git#<ref>`
- `git+ssh://git@github.com/Just-Silver/opencode-goal.git#<ref>`

宿主会把包安装到 opencode 缓存目录（`<global cache>/npm/<key>/<generation>/node_modules/opencode-goal`），再经该包 `package.json` 的 `exports` 解析 `server` 入口。

### 本地目录安装（开发用）

```jsonc
{
  "plugins": [
    { "package": "../opencode-goal", "options": {} }
  ]
}
```

要点：

- **本地插件必须指向"目录"**，不能指向文件——宿主会对文件路径打印 `configured plugin path must be a directory` 并把该项**丢弃**。
- 该目录需有宿主可解析的入口：**根目录的 `server.ts`**（宿主对本地目录依次找 `<目录>/server`、`<目录>/index`；本仓库已提供 `server.ts` 转发到 `src/server.ts`。`main`/`exports` 都**不**参与这条解析路径）。
- 该入口缺失时插件会被**静默丢弃**（无任何告警），`opencode plugin list` 里也看不到。
- 示例里的 `../opencode-goal` 是**相对路径**，相对**配置文件所在目录**解析（换机器/换目录都不用改）；也可写 `file:///...` 绝对 URL。

`options` 见下。

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

## 用法

- `/goal <目标>`：自适应——够具体则自动结构化并 `create`；否则先追问再 `create`。
- `/goal`、`/goal status`：报告当前目标。
- `/goal pause` / `/goal resume` / `/goal clear`：服务端确定性处理（不消耗 token）。
- 目标 active 且会话空闲时会自动续跑；中断等价于暂停。

> 转录里的显示：目标本体（objective / 状态 / 规则）通过 `context` 钩子注入 **system 提示**——不进消息、不进转录，也不随轮次堆积历史；`/goal <目标>` 与每轮自动续跑在 TUI 里只显示**一行**（`Goal request · …` / `Goal auto-continue · …`），命令回执（`pause`/`status`/`/goal-debug` 等）同样是一行通知。

## 调试

两个入口都是**只读**的，不改任何状态：

- **人**：`/goal-debug env | events | sessions | state` —— 确定性、零 token，**不注入模型上下文**。
  - `env`：本实例的 location、目标会话所在目录、归属判定、生效的 `options`
  - `events`：最近 50 条事件 + 归属判定（`allow` / `drop-other-location` / `drop-unknown-session`）
  - `sessions`：已存储的全部 goal 记录；`state`：本会话内存轮状态
- **agent**：工具 `goal_debug(op=...)`（默认注册；description 明写 `DEBUG ONLY`，正常目标工作不要调用）。不想要它出现在模型工具表里就设 `debug: false`。

排查「没续跑 / 重复续跑」时先看 `events` 的 `decision` 列；确认插件是否加载了最新代码看 `env` 里的 `options`。

## 开发

```bash
bun install
bun test
bunx tsc --noEmit
```

## 真机 smoke（手动清单）

> 以下为**手动清单**，需要在具备 OpenCode V2 运行时与确定性模型的机器上人工执行；本仓库的开发/CI 环境不实际执行。

1. 用上面的 `plugins` 配置启动 OpenCode V2。
2. `/goal 在仓库根目录创建一个 hello.txt，内容为 hello，然后用 ls 验证文件存在`。
3. 观察：模型结构化 → 调 `goal(op="create")` → 完成后调 `goal(op="complete")` → 目标状态变 `complete`。
4. `/goal status` 应报告状态；`/goal clear` 后 KV 记录消失（可再用一次 `/goal status` 确认 “No goal”）。
5. 制造一次空转（如 `/goal` 一个当前无法推进的目标），确认连续 3 个自动续跑轮后状态变 `blocked`，且工具返回带收尾指令。
