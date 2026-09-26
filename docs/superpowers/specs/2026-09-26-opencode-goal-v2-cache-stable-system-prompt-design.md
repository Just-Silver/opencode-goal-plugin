# 规格：system 提示词缓存稳定性（缓存优先）

> 状态：待评审。日期：2026-09-26。
> 一句话：让 goal 插件注入 system 的文本在目标 `active` 期间**逐字节恒定**，把随轮次变化的信息移出 system，从而每轮命中 prompt cache。

## 1. 背景与问题

### 1.1 宿主的缓存策略（来自本机宿主二进制 `opencode.exe` 内嵌 bundle，LLM 层）

宿主有**一等、可配置**的缓存策略（`ctx.request.cache`），不是「system 一整块一个断点」：

```js
var Ln = { tools:true, system:true, messages:{tail:1} },   // 默认策略（cache:"auto"）
    Mn = {},                                                // cache:"none"
    In = 4,                                                 // 断点上限 4 个
    bn = (e)=> e===void 0||e==="auto" ? Ln : e==="none" ? Mn : e,
    On = new Set(["anthropic-messages","google-vertex-messages","bedrock-converse","openrouter"]);

Bo = (e) => {
  if(!On.has(e.model.route.id)) return e;
  let o = bn(e.cache);
  let a = Dn(o.ttlSeconds), s = { remaining: Math.max(0, In - Fn(e)) };   // 断点额度
  let i = o.tools    ? Ao(e.tools, a, s)              : e.tools;   // 最后一个 tool
  let c = o.system   ? Bn(e.system, a, s)             : e.system;  // 第一个 + 最后一个 system part
  let p = o.messages ? qn(e.messages, o.messages, a, s): e.messages;// 最后一条消息（tail:1）
  ...
}

// system 断点：只标「首」与「尾」两个 part（中间不标）
Bn = (e,o,a) => { ... e.map((c,p)=>{ if(p!==0 && p!==e.length-1 || c.cache || a.remaining===0) return c; ...标 cache... }) }
// tools 断点：最后一个 tool（递归 namespace）
Ao = (e,o,a) => { let s=e.at(-1); ... }
// messages：latest-user-message / latest-assistant / {tail:n}
```

默认策略（`cache: "auto"`，仅对 `anthropic-messages` / `google-vertex-messages` / `bedrock-converse` / `openrouter` 生效）：

| 位置 | 断点 |
|---|---|
| tools | 最后**一个** tool |
| system | **第一个** part + **最后**一个 part |
| messages | 最后**一条**消息（`tail:1`） |
| 上限 | **4 个**，按 tools→system→messages 顺序消耗额度 |

推论（决定设计的关键事实）：

1. **agent prompt（第一个 system part）有独立断点**，与后面追加的内容解耦 → system 尾部变化**不会**毁掉 agent prompt 的缓存。
2. **最后一个 system part 也占一个断点**。插件注入的 goal 段若落在 system 末尾，就占用这个断点；它每轮变 → **该断点每轮失效**。
3. 中间 system part（如 `initial`）**无独立断点**，仅在「尾断点命中」时才被缓存；尾断点 miss 时它也被重算。
4. messages 断点在最后一条消息，其前缀包含 system → system 尾一变，messages 断点一并 miss。

### 1.2 现状缺陷

插件有两处注入 system（`src/host/hooks.ts:21,30`），都调用 `budgetLines()`：

```
- Tokens used: ${goal.tokensUsed}          ← 每轮累加变化
- Token budget: ${goal.tokenBudget ?? "none"}
- Tokens remaining: ${remaining}           ← 随 tokensUsed 变化
```

`goal.tokensUsed` 每轮增长 → 注入文本每轮不同 → **最后一个 system 断点每轮失效**，连带中间的 `initial` 与 messages 断点一起变冷（agent prompt 因有首断点而幸免）。这是当前的主要成本项。

## 2. 目标 / 非目标

**目标**

- 目标 `active` 期间，注入 system 的文本**逐字节恒定**（同一 objective 下跨轮、跨 resume 一致）。
- 所有「随轮次变化」的信息一律不进入 system。

**非目标**

- 不改状态机、工具面、命令面、i18n、KV schema。
- 不改变 messages 的正常增长（对话/工具结果照常）。
- 不去动宿主侧 `initial` 等非插件控制的 system 段。

## 3. 缓存正确性依据

- 注入只在 `goal.status === "active"` 时发生（`hooks.ts:20`）；`Status` 行不再注入（注入路径上恒为 `active`、无信息量）。
- 其余注入内容在目标 `active` 期间不变：
  - objective 在目标生命周期内不变（唯一写入口是 create / `/goal-rebuild`，后者是用户命令）；
  - 固定规则文本是字面量。
- 移除预算块后，注入文本 = 常量拼接，跨轮逐字节相同 → **最后一个 system 断点（system 尾）命中** → 整个 system（含中间的 `initial`）全部命中。
- 首断点（agent prompt）本就独立命中，不受影响。
- ephemeral 缓存 TTL 默认 5m（可配 `ttlSeconds`）；自动续跑轮间隔通常远小于该值，可命中。
- messages（含 synthetic 续跑触发语）每轮增长，只影响 messages 断点，不影响 system 的首/尾断点。

## 4. 设计

### 4.1 拆分 `goalContext`：只保留稳定段

`src/prompts/index.ts` 的 `goalContext(goal, { maxObjectiveChars })` 输出改为：

```
[Persisted goal]
Objective (…):
<objective>${injectedObjective(goal, maxObjectiveChars)}</objective>

<一整段固定行为规则，原样保留>
```

**删除** `Budget:` 块与 `Status:` 行（不再调用 `budgetLines`，也不再输出 `goal.status`）。

- `Status`：注入只在 `active` 时发生，它恒为 `active`、无信息量；状态变化由插件的提醒通道负责（`blockedWrapUp` / `budgetLimitPrompt` / 宿主信号回执）。
- 结果：注入文本 = `objective` + 固定规则，跨轮逐字节恒定。

### 4.2 `compactionSnapshot` 同步去动态

`src/prompts/index.ts` 的 `compactionSnapshot(...)` 同样删除 `Budget:` 块，仅保留 `Status` / `Objective` / `Continue only while active`。

### 4.3 动态信息的出口（「变化的部分走其他部分」）

动态信息**不再进入 system**，改由既有通道承载：

| 出口 | 通道 | 是否进 system | 用途 |
|---|---|---|---|
| `goal(op="get")` | 工具返回（messages） | 否 | 模型按需取 tokensUsed / budget / remaining（`buildToolResult` 已含全量字段） |
| `/goal` 空参 · `<name>-status` | `notify`（synthetic，`resume:false`） | 否 | 用户查看（`statusLine` 已渲染全部动态） |
| `budgetLimitPrompt` | 工具结果 `instruction`（messages） | 否 | 预算耗尽一次性收尾 |
| `blockedWrapUp` | 工具结果 `instruction`（messages） | 否 | 阻塞收尾 |

即：**模型需要动态数字时自己 `get`；用户需要时命令查看；事件触发时随工具结果送达**——三者都不碰 system。

### 4.4 备选（已否决）：每轮动态数字走 messages 末尾

**决策：不启用。** 模型无需每轮知道额度/状态，插件会在状态变化（预算耗尽 / 受阻）时主动提醒。若将来确有需要再启用：

- 在 `context` 钩子里向 `input.messages` **末尾**追加一条消息，**绝不 push 到 `input.system`**；
- 两种实现：
  - **内存追加（推荐若走此路）**：只改当次请求的 `input.messages`，不落库 → 零历史增长；
  - **落库追加**：`e.session.synthetic({..., resume:false})` + 去重检查（参照内置 `opencode.plan` 的 `iR(s.messages, ...)` 去重），避免每轮叠加。
- 代价：该条位于 system 断点之后，不被缓存；但仍保护了 system 大块。

## 5. 精确改动清单

| 文件 | 改动 |
|---|---|
| `src/prompts/index.ts` | `goalContext`：删 `Budget:` 段；`compactionSnapshot`：删 `Budget:` 段；`budgetLines` 变为无引用 → 删除；`budgetLimitPrompt` **不动**（自带内联预算行，走 tool result，不进 system）。 |
| `src/host/hooks.ts` | 无改动（仍分别 push 到 system）。 |
| `src/host/tools.ts` | 无改动（`get`/`budget` 等返回的 `buildToolResult` 已含全量动态字段，走各自通道）。 |
| `src/prompts/index.test.ts` | 更新断言（见 §6）。 |

## 6. 测试

`src/prompts/index.test.ts`：

1. `goalContext` 含 objective（转义）、`Completion audit`、`op "complete"`。
2. `goalContext` **不含** `Tokens used` / `Tokens remaining` / `Token budget` / `Status:`。
3. **缓存稳定性（核心回归）**：构造同一 objective/status、不同 `tokensUsed`/`timeUsedSeconds` 的两个 goal，断言 `goalContext` 输出**逐字节相等**。
4. `compactionSnapshot` 同样不含预算动态行。
5. `budgetLimitPrompt` 仍含预算信息（防回归：动态信息只在它这里保留）。

`src/host/hooks.test.ts`：保留现有「active 时注入、非 active 不注入」。

## 7. 风险与取舍

| 风险 | 处置 |
|---|---|
| 模型不再每轮看到预算余量 | 预算耗尽由 `budgetLimitPrompt`（工具结果）兜底；模型可按需 `goal(op="get")`。 |
| `/goal-rebuild` 改 objective → system 变 → 一次缓存 miss | 用户命令触发，可接受；属预期。 |
| compaction 请求 system 含快照 | 已同步去动态；且压缩是偶发请求。 |
| 非 Anthropic provider 行为不同 | 缓存策略（`cache` 配置）只对 `anthropic-messages` / `google-vertex-messages` / `bedrock-converse` / `openrouter` 生效，其余 provider 不打断点。本设计「system 恒定」不依赖任何 provider 特性，对它们也无害。 |

## 8. 验证方法

- 单测全绿：`bun test src/prompts/index.test.ts`；再跑 `bunx tsc --noEmit`。
- 真机：设目标自动续跑若干轮，观察 usage 的 `cacheRead` 是否稳定覆盖 system+tools 部分（不再每轮归零重算）。
- `opencode session export <sid>`：确认 messages 未新增每轮动态文本。

## 9. 影响面 / 兼容性

- KV 结构不变，无需迁移；旧 goal 记录直接受益。
- 提示词不本地化，i18n 无影响。
- 发布：改的是 `src/prompts/index.ts`，属行为变更 → 走 CHANGELOG/版本流程。

## 10. 待确认的开放决策

1. **已定：不采用** §4.4 备选。模型无需每轮知道额度/状态，插件会在状态变化时提醒。
2. **已定：删除** `Status:` 行（注入路径上恒为 `active`、无信息量）。
