# AGENTS.md

OpenCode V2 的 goal 插件。单包、**零运行时依赖**、TS ESM，bun 直接加载 `.ts`（无构建）。发布名 `@justsilver/opencode-goal-plugin`。两个入口：server（`src/server.ts`：命令/工具/钩子/事件）+ TUI（`src/tui.ts`：只把命令回执弹成 toast）。

## 命令

- `bun install` —— 安装 devDependencies。
- `bun test` —— 全量单测；测试与源码同目录（`src/**/*.test.ts`）。
- `bun test src/host/events.test.ts` —— 单个测试文件（可加 `-t "用例名"` 过滤）。
- `bunx tsc --noEmit`（= `bun run typecheck`）—— 类型检查。**`bun test` 不做类型检查，改完必须单独跑。**
- `node scripts/changelog.mjs check` —— 版本一致性门禁（`package.json` == `CHANGELOG.md`；发版加 `--tag vX.Y.Z`）。
- CI 门禁（`.github/workflows/ci.yml`）：`bun install --frozen-lockfile` → changelog check → tsc → test。
- 改了 `package.json` 依赖后必须跑 `bun install` 更新 `bun.lock`（CI 用 `--frozen-lockfile`，锁文件不同步会直接失败）。

## 硬约束（容易踩）

- **`dependencies` 必须为空**（零运行时依赖）。**server 侧**对 `@opencode/plugin` / `effect` 只用 `import type`；**TUI 入口例外**：`src/tui.ts` 值导入宿主提供的 `@opencode/plugin/tui`（`Plugin.define`），但**不得**声明 `solid-js` / `@opentui/*` 依赖（会被装进插件 `node_modules` → 双 Solid）。运行时不得 `child_process` / spawn。
- **入口有两条不同路径**：本地目录安装找 `<dir>/server.ts` 与 `<dir>/tui.ts`（根下这两个都是转发器 → `src/`；`main`/`exports` **不参与**这条）；npm/git 安装走「包名 + `exports` 子路径」（`.` / `./server` / `./tui` / `./rpc`）。改入口时两条都要顾。
- **`package.json.files` 决定发布内容**：`src/**/*.ts`（排除 `*.test.ts`）、`server.ts`、`tui.ts`、`CHANGELOG.md`。新增运行时文件必须落在这些路径内，否则不进 npm 包。
- **注入 system 只放「生命周期内逐字节不变」的内容**：会随轮次变化的字段（用量、耗时、状态标签、时间戳…）一律走 messages（工具返回、续跑/停摆的合成消息，或 `hook("context")` 的 `input.messages`），或走**命令回执 toast**（RPC 事件 → TUI，0 token、不进上下文）——否则每轮击穿宿主打在「最后一个 system part」上的 prompt 缓存断点。详见 `docs/opencode/prompt-cache.md`。
- tsconfig：`verbatimModuleSyntax`（类型导入必须 `import type`）、`noUncheckedIndexedAccess`（索引访问为 `T | undefined`）、`include: ["src"]`。

## 架构

- 分层：`src/model/`（纯逻辑，无宿主依赖）→ `src/store/`（`ctx.storage` KV，key `goal:<sessionID>`）→ `src/host/`（命令/工具/钩子/事件适配）→ `src/server.ts`（组装 + 返回 Cleanup）。
- 副作用全经 `GoalDeps` 注入（`repo` / `options` / `now` / `messages` / `sessionDirectory` …）。**新增依赖就加进 `GoalDeps`**，并同步所有测试的 `makeDeps`（必填字段会波及全部测试）。
- 轮边界只认 `session.execution.*`（`started`/`succeeded`/`failed`/`interrupted`）。`session.status` / `session.idle` 是 deprecated、**后端从不 emit**，别用。
- 命令回执（`/goal-status`、pause、budget…）走 RPC `notice` 事件：`src/rpc.ts` 定义 schema（纯字面量，零依赖），`src/tui.ts` 订阅弹 toast。**坑**：`events.on` 回调收到的是**包装对象**，payload 在 `event.data`；事件会广播给同 location 的所有 TUI，故 TUI 按 **session root** 过滤；正文由服务端 `clampNotice` 封顶（约 12 行 / 54 列，toast 无滚动）。
- **reload 代际兜底**：宿主 `opencode reload` 在 location 仍有活引用时**不会调旧激活的 cleanup**（`RcMap.invalidate` 只摘键不关作用域）→ 旧事件订阅泄漏、续跑被重复投递 N 倍。`src/host/generation.ts` 用 `globalThis` 代际登记主动 abort 旧一代。**新增任何事件订阅/会话钩子都要过 `generation.isCurrent()`**，否则会破坏这个兜底。

## i18n

- 面向用户文案在 `src/i18n/`：`en.ts` 与 `zh-CN.ts` **必须同时加同一个键**（`satisfies Messages`，漏键 `tsc` 报错）；值用 `{占位符}` + `format()` 插值。语言在 `setup` 解析一次，经 `GoalDeps.messages` 注入。
- **不本地化**：`src/prompts/` 的模型提示词、工具错误信息、工具输出、配置校验错误、日志。

## 测试约定

- `src/host/*.test.ts` 的 `makeDeps` 必须带 `messages: messagesFor("en")`（保持英文断言）。
- 走 `plugin.setup()` 的测试（`server.test.ts`）用 `options: { language: "en" }` 固定语言——**不要依赖机器 locale**。
- 真机冒烟会真动会话、耗模型额度：`bun scripts/smoke-api.mjs --session ses_xxx`（详见 `CONTRIBUTING.md`）。

## 热重载（重要）

- 插件从**本地目录**加载时，改 `src/**` 会触发宿主**热重载**；在插件自己的会话里改代码会把当前会话弄挂。
- 规避：改 `src/**` 前先把插件从 `~/.config/opencode/opencode.json` 的 `plugins` 临时移除；或改用 npm 安装（**不 watch**，改完需 `opencode plugin update` + `opencode reload`）。

## 发布

- 单包版本源 = `package.json`；要求 `tag == CHANGELOG == package.json`（`scripts/changelog.mjs` 强制）。
- 步骤：把 `[Unreleased]` 整理成带日期的新版本小节（发布提交里**在新小节上方保留一个空的 `## [Unreleased]`**）→ bump `package.json` → `node scripts/changelog.mjs check --tag vX.Y.Z` → `git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z`（tag 触发 CD：npm 发布 + GitHub Release）。版本决策 `fix → patch` / `feat → minor`。详见 `docs/opencode/releasing.md`。
- **提交信息用中文。**

## 文档导航

- `README.md` 面向**使用者**（安装/用法/配置项）——别往里塞开发细节；开发内容放 `CONTRIBUTING.md`。
- 设计规格/计划：`docs/superpowers/{specs,plans}/`；宿主事实与踩坑：`docs/opencode/{plugin-dev-gotchas,prompt-cache,known-issues,config-install,releasing,smoke-checklist}.md`。
- `.superpowers/` 是本地 SDD 临时产物（已 gitignore），不要提交。
