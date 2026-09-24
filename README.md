# opencode-goal

Codex/OMP 风格的持久目标能力，用于 OpenCode V2：`/goal` 命令 + `goal` 工具 + 空闲续跑 + 证据式完成 + blocked/预算护栏。

## 安装（配置安装）

在 `opencode.json(c)` 加入：

```jsonc
{
  "plugins": [
    { "package": "file:E:/Code/Projects/Agent/opencode-goal", "options": {} }
  ]
}
```

（发布到 npm 后改成 `"opencode-goal"`；options 见下。）

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

## 用法

- `/goal <目标>`：自适应——够具体则自动结构化并 `create`；否则先追问再 `create`。
- `/goal`、`/goal status`：报告当前目标。
- `/goal pause` / `/goal resume` / `/goal clear`：服务端确定性处理（不消耗 token）。
- 目标 active 且会话空闲时会自动续跑；中断等价于暂停。

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
