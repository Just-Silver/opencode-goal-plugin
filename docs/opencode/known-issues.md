# 已知问题 / TODO

> 只记**已定位、暂缓修复**的问题。每条要写清：现象 / 根因（含出处）/ 影响 / 建议修法 / 怎么验证。修完就删条目。

### [ ] 插件热重载后模型解析失败 → 该轮 drain 失败、自动续跑不触发（宿主 bug）

**现象**：改动 `src/**`（或任何触发插件热重载的操作）时，若正好有会话在跑一轮，该轮以 `Failed to drain Session` 失败，且**不再自动续跑**（goal 停在 `active`、`tokensUsed=0`）。用户会误以为「新插件坏了、不续轮了」。

**根因（宿主 bug，非本插件）**：opencode 插件热重载后模型注册表短暂失效。服务端日志（`~/.local/share/opencode/log/opencode.log`）实证：

```
level=ERROR message="Failed to drain Session"
cause="SessionRunnerModel.ModelUnavailableError: Model unavailable: r4-coder/deepseek-v4.1-flash"
```

对应上游 open issue：#47114（plugin hot-reload 后 provider 回落/401）、#51128（reload during a turn → step retry 失败、`Model unavailable`）。注意：该错误在本插件的代际守卫**引入之前**（日志 23:19 / 23:29）就已出现，与本插件无关。

**影响**：开发期高频热重载时，正在跑的轮次失败、续跑中断；通常**自愈**（下一次 location boot 恢复），持续不恢复需重启服务。

**规避**：不要在会话正跑一轮时热重载插件；改 `src/**` 前先等轮次结束。

**验证**：热重载后立刻重跑 `bun scripts/smoke-api.mjs --session <sid> --scenario continuation`；若 `PASS`（比值 1）说明模型已恢复、续跑正常。

---

### [ ] 同一 location 存在多个存活插件激活 → 自动续跑被重复投递 N 倍

**现象**：跨轮续跑时，**一次 `session.execution.succeeded` 会投递 N 条 `Goal auto-continue`**（真机实测：每轮 3~6 条；截图里模型自述「本轮收到了 5 条 Continue 提示」）。`session.inbox.enqueued` 里 N 条内容相同、时间差 1–2ms。

**根因（已确认，宿主 bug：`location.reload` 在 location 活跃时不关闭旧服务图）**：

- `opencode reload` → `LocationServiceMap.reload()`（`packages/core/src/location-service-map.ts`）：`RcMap.invalidate(ref)` 后重建。
- Effect `RcMap.invalidate`（`effect/src/internal/rcMap.ts`）：

  ```js
  const entry = o.value
  MutableHashMap.remove(self.state.map, key)
  if (entry.refCount > 0) return          // ★ 有活引用就只摘键、不关闭
  yield* core.scopeClose(entry.scope, core.exitVoid)
  ```

  即：**location 只要还有活引用（refCount>0，例如该会话正在跑一轮），`invalidate` 就不关闭旧图**。旧图里的 `Plugin.Service` → 插件激活 → `setup` 的 cleanup **永远不会被调用** → 那条订阅全局事件流的循环继续跑 ⇒ 幽灵激活。

**决定性证据（2026-09-25，隔离探针，未改 `src`）**：在临时目录放一个只写日志的探针插件（`setup`/`cleanup`/收事件），临时加入全局配置后：

- **空闲 location**：reload 时旧实例被正常 `cleanup`。
- **正在跑一轮的 location（D）**：reload 时 **只新增 setup、没有对应 cleanup**；该旧实例随后**仍收到 `session.execution.*` 事件**：

  ```
  MARK RELOAD WHILE RUNNING
  cleanup 99iyvj loc=C:\Users\13178            ← 空闲，正常关
  cleanup x0yvc0 loc=E:\...opencode-goal       ← 空闲，正常关
  cleanup wwjjcg loc=...oc-leak-probe          ← 空闲，正常关
  setup   mmr066 ...
  setup   l9bmlx ...
  setup   ndy8uh ...
  setup   l0tpb9 loc=D:\下载\Goal冒烟          ← D 只新增，没有 cleanup e40c0o！
  ```

- **对照实验**：探针 `cleanup` 里 `abort.abort()` 时，被 cleanup 的旧实例之后收到 **0** 个事件；不 abort 的版本则继续收事件。**证明：宿主一旦调用 cleanup，我们插件的 `abort.abort()` 能真正停掉循环。**

**结论：是宿主（opencode）的 bug，不是本插件的问题。** 我们插件的清理逻辑是正确的；只在宿主不调用 cleanup（location 活跃时 reload）时被动受害。任何"好插件"都会同样中招。

**影响**：开发期高频 reload（改配置/改插件文件）且此时有会话在跑 → 幽灵激活累积 → 续跑 N 倍、token 翻倍、内存增长。普通用户偶发。

**建议修法**：
1. **插件侧兜底（推荐）**：进程级共享 `globalThis[Symbol.for("opencode-goal.active")]`，按 `locationDirectory` 记「当前代际 + AbortController」。`setup` 时先 `abort()` 同 location 的上一代，并让**事件循环与 hook 回调先校验自己仍是当前代际**，否则 no-op。这样即使宿主不调 cleanup，新实例也能把旧幽灵循环按停、旧实例的内存随之可回收。`globalThis` 跨模块实例共享、单线程无竞态，优于共享 KV。
2. **上游报告**：`LocationServiceMap.reload()` 在 `refCount>0` 时未释放旧 location 图；reload 应强制关闭旧作用域（或等待其引用释放）。

**验证命令**：`bun scripts/smoke-api.mjs --session <sid> --scenario continuation`，比值 `auto-continue 回执 / execution.succeeded` 应 ≈ 1。冒烟断言已补 `cont <= succeeded` 卡 N 倍回归。最稳的复现：**在会话正跑一轮时 `opencode reload`**。

---

> 已修的历史条目看 git 历史；对应的踩坑与实测方法沉淀在 `plugin-dev-gotchas.md` §8（会话删除事件 + 插件侧错误形状）。

---

## 上游问题跟踪（opencode 宿主侧，非本仓库可修）

> 不是本插件的 bug，但会影响我们的用户（尤其是我们推荐 git 安装之后）。**上游关闭并回归验证后删条目。**
> 早期记录来源：`Just-Silver/opencode-tui-usage` 的 `TODO.md` / `docs/config-install.md`；下面的根因我们**在宿主 v2 源码里重新核过**（2026-09-25）。

### [ ] #50868 未钉版本的 git 插件，冷启动更新检查会弹 Windows 控制台窗口

**现象**：`opencode.json(c)` 的 `plugins` 里写**未钉版本**的 git 源（如 `github:owner/repo`）时，凡**需要解析该 spec** 的场合（首次安装、`opencode plugin check`、`opencode plugin update`）都会 spawn `git ls-remote` 且未设 `windowsHide` / `CREATE_NO_WINDOW` → Windows 上弹出可见控制台窗口（一闪）。清掉 `~/.cache/opencode/npm/**` 后重启（强制重装，每个 location 各一次）会弹更多次（上游报告实测 3 次）。

**上游**：<https://github.com/anomalyco/opencode/issues/50868>（`server: unpinned plugin update check flashes visible git console window on Windows`）

- 本仓库 2026-09-25 用 `gh api` 复核：**仍 open**（创建于 2026-09-23、0 评论）。
- 同类历史 issue（**均 closed**，修法可参考）：#42440、#38715、#31629、#30315 —— 都是「Windows 子进程 spawn 闪窗」。

**根因（在宿主 v2 源码里自查）**：

| 环节 | 事实 |
| --- | --- |
| 安装 / 更新入口 | `packages/util/src/npm.ts`：`Npm.add` / `Npm.update` → `new Arborist(...).reify(...)` |
| 相关依赖 | 宿主 `bun.lock`：`@npmcli/arborist@9.4.0` + `pacote@21.5.1`（pacote 依赖 `@npmcli/git`，`git ls-remote` 由它执行） |
| **关键证据** | 宿主源码里搜 `ls-remote` = **0 命中**、`CREATE_NO_WINDOW` = **0 命中**；`windowsHide` 只出现在 desktop / cli 自己 spawn 的地方 ⇒ **弹窗来自依赖层**，不是 opencode 手写的代码 |
| 可排除 | 宿主给 pacote 打的补丁 `patches/pacote@21.5.1.patch` 只处理 git tarball / 子目录取包，**与弹窗无关** |

**影响**：只有**选 git 安装**（见 `CONTRIBUTING.md`）且未钉 SHA 的用户会遇到；README 默认推荐的 npm 包名不受影响。

**规避（按推荐度）**：

1. **钉满 40 位 commit SHA**：上游明确 full commit hash 会跳过 update check → 完全不弹；代价是**没有自动更新**。本机全局配置就是这么装的。（**tag 是否同样跳过 —— 未验证**）
2. 别删 `~/.cache/opencode/npm/**`（删了会强制重装 → 弹更多次）。
3. 想「能查新版且不弹窗」：用 **npm 包名**（走 registry HTTP，不 spawn git）——本插件已发布为 **`@justsilver/opencode-goal-plugin`**，也就是 README 安装一节推荐的方式。（注意：**不会自动更新**，要升级得主动 `opencode plugin update`）
4. **发现式安装**（把插件目录放到 `~/.config/opencode/plugins/`）——本地开发时用的就是这条，无弹窗。

**动作**：

- [x] git spec 要 pin 40 位 SHA + Windows 弹窗提示已写明（2026-09-25；同日随开发向内容从 README 移到 `CONTRIBUTING.md`）
- [ ] 跟踪上游 #50868；上游关闭后回归验证（**去掉 pin** 并清掉 `<cache>/npm/git-*` 后重启，或直接跑 `opencode plugin check` → 看是否仍弹）
- [ ] 若上游长期不修：评估在 `CONTRIBUTING.md` 更醒目处提示（README 已默认为 npm 安装，不再暴露 git 方式）

**备注**：本插件自身**不 spawn 任何进程**（全仓 `child_process` / `spawn(` / `exec(` / `Bun.spawn` / `fork(` 均 0 命中；运行时 import 只有相对路径 + 宿主提供的 `@opencode/plugin` 类型），所以这个弹窗 100% 来自宿主 / 依赖层。

### [ ] 泄漏 / reload 相关上游 issue 跟踪（#36677 / #48121 / #47114 / #51128）

> 2026-09-25 用 `gh` 复核：**4 条全部 OPEN，没有任何一条有已合并的修复 PR**。

| Issue | 标题 | 状态 | 修复 PR | PR 状态 |
| --- | --- | --- | --- | --- |
| [#36677](https://github.com/anomalyco/opencode/issues/36677) | core: long-lived V2 server enters persistent allocation loop | OPEN（bug/perf/core/2.0） | #38825 关闭 promise 插件事件订阅 | CLOSED **未合并** |
| | | | #38939 allBounded 监听器泄漏 | CLOSED **未合并**（旧 PR 自动清理） |
| | | | #46179 避免 LocationActivity 热路径 Effect 分配 | CLOSED **未合并**（2h 未更新被自动关） |
| [#48121](https://github.com/anomalyco/opencode/issues/48121) | core: concurrent location plugin reloads crash with `r.base.get` | OPEN（2.0） | 无 | — |
| [#47114](https://github.com/anomalyco/opencode/issues/47114) | providers: request falls back to anthropic (401) after plugin hot-reload | OPEN（2.0） | 无 | — |
| [#51128](https://github.com/anomalyco/opencode/issues/51128) | Plugin reload during a turn fails the step retry | OPEN | #51133 每个 runner step 前等插件激活 | **OPEN**（target `v2`） |

- #38825 被维护者以「该泄漏路径已不可达」关闭（称 `ctx.event.subscribe` 随 namespaced hook API 移除）。**但那修的是「Promise 插件 `for await` 未调 `return()`」，与本插件的「`refCount>0` 时 cleanup 根本不被调用」是两条路径。**
- 本仓库 2026-09-25 已就 #36677 补充探针复现与根因：<https://github.com/anomalyco/opencode/issues/36677#issuecomment-5826615158>
- 同日在 #51128 补充 v2.0.15 实测佐证（`Failed to drain Session` + `ModelUnavailableError` + 技能全被标记移除）：<https://github.com/anomalyco/opencode/issues/51128#issuecomment-5826624809>
- **动作**：跟踪上游；若 #51133 / #36677 关闭并回归验证后删条目。

### [ ] 升级复核：`ctx.event`（单数）是否仍存在（可能被 namespaced hook API 取代）

**背景**：维护者在 #38825 关闭说明（2026-07-25）称，`ctx.event.subscribe()` 随 namespaced hook API（`909a1a6d7`）落地已被移除，`PluginContext` 已无 `event` 字段，`packages/plugin/src/v2/effect/event.ts` 是未接线的孤儿类型。

**现状（2026-09-25，opencode v2.0.15）**：本插件 `ctx.event.subscribe({ signal })` **仍可用** —— 本地 externals 的 `PromiseContext["event"]["subscribe"]` 仍在，真机实测在收事件、续跑正常。**暂时无需改动。**

**注意（勿轻信）**：该说法出自 **7 月的旧评论，可能已过时**；且 #38825 针对 `dev` 分支，我们跑的是 `v2` 分支，两条分支未必同步。

**待办**：每次升级 opencode 前复核 `PluginContext` 是否仍有 `event`；若被移除，迁移到 namespaced hook API 或等价的事件订阅入口。

**验证**：升级后跑 `bun scripts/smoke-api.mjs --session <sid>`（全量场景，当前 15 个）应全绿；若事件订阅 API 变更，续跑/记账会直接失效。

---

## V2 待办（V1 收尾时确认推迟）

> 2026-09-25 V1 收尾：以下项**确认推迟**，移交 V2。（原「0.1.1 发布推迟」一项已于 2026-09-25 完成发布，见 `CHANGELOG.md` 的 `[0.1.1]` 与 GitHub Release `v0.1.1`。）
> **2026-09-25 更新（v0.2.0）**：V2 子项目 2/3 与 i18n 均已交付，下列条目**全部移出**。
> 「后台任务（background subagent / shell）运行期间不应自动续跑」已于 V2 子项目 2 实现（见 `CHANGELOG.md` 的 `[0.2.0]`）。
> 「宿主信号 → 状态（`provider.quota` → `usage-limited`；宿主终态错误 → `blocked`）」已于 V2 子项目 3 实现（见 `CHANGELOG.md` 的 `[0.2.0]`）。
> 「国际化（i18n）」已于 V2 实现（见 `CHANGELOG.md` 的 `[0.2.0]`）。默认跟随系统 locale，可用 `language` 覆盖。

---

## 上游功能请求（待提 issue）

### [ ] 插件缺少「只发给用户看、不进模型上下文」的输出通道

**状态**：已定位。**本插件已绕过**（0.5.0：命令回执改走 RPC 事件 → TUI 插件的 `ui.toast.show`，0 token）——但那是"自己搭通道"，上游仍缺原生出口；issue 仍值得提。

**现象**：服务端插件要让**用户**看到一行反馈（命令回执、状态展示），唯一出口是 `ctx.session.synthetic(...)`。但这条消息的 `text` **必然进入模型上下文**（下一轮以 `[Synthetic context]` 出现），即使 `resume: false` 也一样。`description` 虽然只用于 TUI 显示，却**无法单独发送**——即"给用户看"与"喂给模型"被绑在同一条消息上。（0.5.0 起本插件用 `ctx.rpc.register` → TUI 的 `ui.toast.show` 绕过，但那是插件自己搭通道，上游仍缺原生出口。）

**证据（本机 `@opencode/plugin` 2.0.16 / `@opencode/schema` / `@opencode/client` 类型）**：

- `SessionSyntheticInput = { sessionID; text: string; description?: string; …; resume?: boolean }` —— `text` **必填**（无最短长度限制，但不可省略）。
- `SessionMessage.Synthetic = { text: Schema.String; description?: Schema.String; … }` —— `text` 必填。
- `to-llm-message`：`case "synthetic": return [{ role: "user", content: message.text }]` ⇒ `text` 进模型。
- 服务端命令 `CommandDefinition.execute` 返回 `Promise<void>`（**无返回值通道**）；服务端 `Context` **没有** `ui.*`（`ui.toast` / `ui.dialog` 属 TUI 插件）。

**影响**：任何"确定性命令 / 纯 UI 回执"都被迫写入模型上下文——用户为**纯界面信息**付 token，并**污染模型上下文与思维链**。本插件因此被迫把全部命令回执改为 TUI 界面通道（见规格 `docs/superpowers/specs/2026-09-26-opencode-goal-v2-tui-zero-token-display-design.md`）。

**本插件的现状（0.5.0）**：命令回执 → RPC 事件 → TUI toast（0 token、不写会话消息）；**必须留痕**的提示（停摆回执）仍走 `synthetic` + `resume: true`（`text` 给模型、`description` 给人看，代价是醒来一轮）。详见 `plugin-dev-gotchas.md` §6 / §11。

**请求（issue 正文要点）**：提供一种「只面向用户、不进模型上下文」的输出通道。候选方案：

1. `synthetic` 的 `text` 改为**可选**：仅给 `description` 时，该消息**不进 LLM 上下文**（仅转录显示）。
2. 新增服务端可用通道，如 `ctx.session.notice(...)` / `ctx.ui.toast(...)`（等价于 TUI 的 `ui.toast`，但不落库、不进模型）。
3. `CommandDefinition.execute` 支持返回一段"仅显示、不进模型"的文本。

**验证**：用探针钩 `http.request` 抓发往 provider 的请求体；执行一条命令后，`messages` 应**无新增**，而 TUI 仍显示回执。
