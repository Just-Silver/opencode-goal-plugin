# Prompt 缓存与 system 注入：插件开发经验（含实测）

> 面向 OpenCode V2 插件开发者（也适用于任何"往模型请求里注入上下文"的 Agent 插件）。
> 结论来自：宿主 `opencode.exe` 内嵌 bundle 的源码核实 + 本仓库真机实测。凡未证实处均已标注。
> 一句话：**会随轮次变化的内容，绝不放进 system；system 只放生命周期内稳定的内容。**

## 0. TL;DR

1. prompt 缓存是「**前缀匹配 + 显式断点**」。从请求开头到断点之间，**一个字节变了，从变化处到该断点就全部作废**、按全价重算。
2. 宿主会在固定位置打断点。其中 **system 的最后一个 part** 有一个断点——**你注入在 system 末尾的任何每轮变化的内容，都会击穿它**。
3. 所以：**随轮次/进度变化的东西（用量计数、耗时、状态标签、时间戳…）不要进 system**。它们的出口是 messages：工具返回、命令回执、事件提示——都不碰 system。
   ⚠️ 但 **「不进 system」≠「零成本」**：工具返回与**合成消息**（续跑触发、停摆回执）最终都会进模型上下文（下一轮以 `[Synthetic context]` 出现），只是位于 system 之后的 messages 区、不击穿 system 断点。文本越长，后续每轮 token 越多。**命令回执**走 RPC toast，不进上下文。
4. `system` 里只保留「在该目标/会话生命周期内逐字节不变」的内容。
5. 验证方法：用探针插件抓真实请求体，比较连续请求的 system 哈希。**API 拿不到 system**（见 §5）。

---

## 1. 宿主的缓存机制（源码核实）

宿主在 LLM 层有一等、可配置的缓存策略（不是"system 一整块一个断点"）：

```js
// 默认策略（cache: "auto"）
var Ln = { tools: true, system: true, messages: { tail: 1 } },
    Mn = {},                                   // cache: "none"
    In = 4,                                    // 断点上限 4 个
    bn = (e) => e === undefined || e === "auto" ? Ln : e === "none" ? Mn : e,
    On = new Set(["anthropic-messages", "google-vertex-messages", "bedrock-converse", "openrouter"]);

Bo = (e) => {                                  // 在发请求前把 cache hint 打到内容块上
  if (!On.has(e.model.route.id)) return e;
  let o = bn(e.cache);
  let a = Dn(o.ttlSeconds), s = { remaining: Math.max(0, In - Fn(e)) };  // 断点额度
  let i = o.tools    ? Ao(e.tools, a, s)              : e.tools;   // 最后一个 tool
  let c = o.system   ? Bn(e.system, a, s)             : e.system;  // 第一个 + 最后一个 system part
  let p = o.messages ? qn(e.messages, o.messages, a, s): e.messages;
  return ln.update(e, { tools: i, system: c, messages: p });
};

// system 断点：只标「首」与「尾」两个 part，中间不标
Bn = (e, o, a) => e.map((c, p) => {
  if (p !== 0 && p !== e.length - 1 || c.cache || a.remaining === 0) return c;
  a.remaining -= 1;
  return { ...c, cache: o };
});

// tools 断点：最后一个 tool（递归 namespace）
// messages 断点：latest-user-message / latest-assistant / { tail: n }
```

**默认策略（`cache: "auto"`）**：

| 位置 | 断点 |
| --- | --- |
| tools | 最后**一个** tool |
| system | **第一个** part + **最后一个** part |
| messages | 最后**一条**消息（`tail: 1`） |
| 上限 | **4 个**，按 tools → system → messages 顺序消耗额度 |

### 由此得到的关键推论

1. **agent 人设（第一个 system part）有独立断点**，与后面追加的内容解耦 → system 尾部变化**不会**拖累它。
2. **最后一个 system part 也占一个断点**。插件把内容 push 到 system 末尾，就占用它——**它每轮变，这个断点就每轮失效**。
3. 中间 system part（如 `initial`）**没有独立断点**，只在尾断点命中时被缓存；尾断点 miss 时它也被重算。
4. messages 断点在最后一条消息，其前缀包含 system → system 尾一变，messages 断点一并 miss。
5. **稳定内容放前面 ≠ 命中**。命中要求「断点之前的全部内容稳定」；断点在后面，就把后面的动态内容也算进了缓存键。

### provider 差异（重要）

上面这套 cache hint **只对** `anthropic-messages` / `google-vertex-messages` / `bedrock-converse` / `openrouter` 生效。其它 provider（如 `openai-compatible`）不由宿主打断点，走 provider 自己的**自动前缀缓存**。

以 openai-compatible 为例，宿主把 system 各段**合并成 `messages[0]`（`role:"system"`）**，后面的对话依次接上；DeepSeek 这类 provider 会自动对消息前缀做缓存。**结论不变**：system 这段一变，整个前缀缓存作废。

---

## 2. 反模式：把动态内容注入 system（我们踩过的坑）

本仓库的 goal 插件曾经在每请求注入 system 的「目标上下文」里带上：

```
Status: active
Budget:
- Tokens used: 247365      ← 每轮累加，一直在变
- Token budget: none
- Tokens remaining: ...
```

后果：目标 `active` 期间，**每个新轮的第一个请求**都会因为 `Tokens used` 变了而撞掉 system 尾断点，连带中间的 `initial` 一起重算。

### 真机实测（未修复版）

探针抓到的 16 次真实请求（跨多轮）：

```
# 1  sysLen= 33121  sysHash=9b9044d66ad4  tokensUsed=0
# 2  sysLen= 33125  sysHash=20552c9c770b  <== CHANGED  tokensUsed=12828
# 3  sysLen= 33125  sysHash=fb9bb640a07b  <== CHANGED  tokensUsed=25835
# 4  sysLen= 33125  sysHash=b4407fbd3a20  <== CHANGED  tokensUsed=38931
...
#16  sysLen= 33126  sysHash=086b87614d2a  <== CHANGED  tokensUsed=200082
```

**16 次请求的 system 哈希无一相同**；逐字符 diff 显示**唯一差异就是 `- Tokens used` 那个数字**。缓存被每轮击穿。

---

## 3. 正确做法

### 3.1 system：只放生命周期内稳定的内容

`goalContext` 改为只含 `objective` + 固定规则文本（连 `Status:` 行也删了——注入只在 `active` 时发生，它恒为 `active`、无信息量）。`compactionSnapshot` 同步去动态。

### 3.2 动态信息换出口

| 谁要看 | 出口 | 进 system？ | 进模型上下文？ |
| --- | --- | --- | --- |
| 模型按需 | 工具返回（tools 结果 → messages） | 否 | **是**（本来就是给模型的） |
| 用户查看 | 命令回执（RPC 事件 → TUI toast） | 否 | **否**（不写会话消息）。**留痕**型提示（停摆回执）才走 `session.synthetic` + `resume: true`，那时才进模型 |
| 事件触发 | 工具结果里的 `instruction` / 通知 | 否 | **是** |

> ⚠️ 停摆回执（预算命中 / 用量受限 / 受阻）必须写进**会话转录**才会被看到，只能走 `session.synthetic`；而合成消息**投递后 `text` 必然进模型上下文**（`[Synthetic context]`），并且**只有 `resume: true` 才会被投递**——`resume: false` 在终态下**永不送达**（轮末忙期已 settle，没有 drain 来投递它；见 `plugin-dev-gotchas.md` §11）。所以这类回执要把 `text` 写成**收尾指令**、`description` 写成给人看的一行，并接受"多一轮收尾"的代价。**命令回执**则走 toast（0 token、不进模型），不要再用 synthetic。

### 3.3 若确实要每轮把动态信息给模型

用 `context` 钩子往 `input.messages` 追加（**绝不 push 到 `input.system`**）：

- **内存追加**：只改当次请求的 `input.messages`，不落库 → 零历史增长，最干净。
- **落库追加**：`session.synthetic({..., resume:false})` + **去重**（下轮从存储加载时已在里面就跳过），否则每轮叠加。
- 参考宿主内置 Plan 模式（`opencode.plan`）：它就是这样做的——
  `s.messages.splice(end, 0, UserMessage)` + `session.synthetic(..., resume:false)` + `iR(s.messages, ...)` 去重。

> 注意取舍：追加到 messages 的那条**位于断点之后，不被缓存**；但它保住了 system 大块。只适合"小块、必要"的动态信息。

---

## 4. 容易忽略的细节

- **稳定内容不能全搬进 messages**：那样它就完全不缓存了。原则是"稳定→system（被缓存），动态→messages（不缓存）"。
- **tools 也会变**：MCP 连接/断开、工具增删会改变工具列表，击穿 tools 断点。这是低频事件，可接受；但别每轮改工具描述。
- **同一轮内的多次请求**：用量通常**轮末才落库**（本仓库 goal 插件即如此），所以轮内各 step 看到的 system 相同 → 轮内命中；**跨轮**才变。别把"轮内命中"误当成"没问题"。
- **别把「稳定」理解成「文本短」**：`objective` 即使很长，只要不变，放 system 反而最划算（被缓存）。
- **边界**：宿主自身可能在其他 system part 里放动态内容（如环境/时间）；那是宿主的事，你控制不了，但你至少别**再往里加**。

---

## 5. 怎么验证（可复用的实测方法）

**API 拿不到 system**（已核实）：OpenAPI 里 `SystemPart` 引用数为 0；`GET /api/session/{id}/context` 只返回**持久化消息**（上次压缩之后），不含系统提示注入。`opencode debug` 只有 `agents/config/paths`。

所以只能靠**插件钩子**抓真身。两种钩子：

- `ctx.session.hook("context", (e) => ...)` → 拿到装配好的 `e.system`（数组）与 `e.messages`；
- `ctx.session.hook("http.request", (e) => ...)` → 拿到**真正发往 provider 的 `Request`**（含最终 body），最硬的证据。

探针骨架（发现式安装：放在 `~/.config/opencode/plugins/<name>/server.ts`，宿主自动加载；测完删目录 + `opencode reload`）：

```ts
import { appendFileSync } from "node:fs"

const OUT = "<临时目录>/probe.jsonl"

export default {
  id: "prompt-cache-probe",
  async setup(ctx: any) {
    ctx.session.hook("context", async (input: any) => {
      appendFileSync(OUT, JSON.stringify({ hook: "context", sid: input.sessionID, system: input.system }) + "\n")
    })
    ctx.session.hook("http.request", async (e: any) => {
      let body: string | undefined
      try { body = await e.request.clone().text() } catch {}
      appendFileSync(OUT, JSON.stringify({ hook: "http.request", sid: e.sessionID, kind: e.kind, body }) + "\n")
    })
  },
}
```

然后：在目标会话制造 ≥2 次请求（两轮），抽取 `messages[0]`（openai 路径）或 system 段，比较**哈希**；相同即为恒定。

> 实测对比（同一目标、跨轮）：
> - 未修复：16 次请求，system 哈希**全不同**；
> - 修复后：3 次请求跨 3 轮（`tokensUsed` 0→18649→56128），system 哈希**逐字节相同**。

**别用模型配合来制造跨轮**：模型每轮回一个非空词就不算"空转"，会一直自动续跑、烧额度。可控做法是给目标设 token 预算让它自动停在 `budget-limited`，或直接写 KV 造目标（仅测试用）。本次实测第一轮就因模型持续回 "ok" 跑了 6 轮、烧掉约 20 万 tokens。

---

## 6. 改动前检查清单

- [ ] system 注入是否**只含**会话/目标生命周期内稳定的内容？
- [ ] 任何随进度变化的字段（计数、耗时、`status`、时间戳、剩余额度）是否已**排除出 system**？
- [ ] 动态信息是否有**非 system 的出口**（工具返回 / 命令回执 / 事件提示）？（注意：这三种**都会进模型上下文**，只是不击穿 system 断点；回执/返回越短越省）
- [ ] 若走 messages：是内存追加还是落库？落库是否**去重**？
- [ ] 改了 tools 描述/清单吗？是否每轮都变？
- [ ] **实测**：连续两次请求的 system 哈希是否相同？（§5 探针）

## 7. 出处

- 缓存策略与断点位置：宿主 `opencode.exe` 内嵌 bundle（LLM 层 `cache` 策略、`Bn`/`Ao`/`qn`），二进制被压缩，函数名为宿主内部短名。
- 本仓库实现：`src/prompts/index.ts`、`src/host/hooks.ts`。
- 设计规格：`docs/superpowers/specs/2026-09-26-opencode-goal-v2-cache-stable-system-prompt-design.md`。
- 宿主内置范例（动态内容走 messages）：`opencode.plan` 的 context 钩子。
