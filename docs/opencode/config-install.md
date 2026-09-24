# OpenCode 插件：配置安装（config install）资料汇总

> 来源：`Just-Silver/opencode-tui-usage` 的 `docs/config-install.md`
> （<https://github.com/Just-Silver/opencode-tui-usage/blob/main/docs/config-install.md>）。
> 下面是**阅读后自己的归纳**，不是原文照抄；结论均为该仓库在本机 OpenCode 上的实测记录，随版本可能变化。
> 采集日期：2026-09-24。

## 0. 一句话

在 `opencode.json(c)` 的 `plugins` 数组里写一行 spec，OpenCode 启动时会用 npm arborist 自动把包（含依赖）装到全局缓存再加载入口 —— **不需要自己写安装脚本、也不需要发布到 npm registry**。
**适用范围：server 侧插件**。TUI 插件（Solid/JSX）目前**不能**用配置安装（会踩「双 Solid 运行时」），见第 4 节。

## 1. 机制

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<spec>"]
}
```

`<spec>` 可写：

- npm 包名：`name` 或 `@scope/name`
- GitHub：`owner/repo` 或 `github:owner/repo`，可带 ref：`#v1.2.3`、`#<40位commit>`

加载流程：OpenCode 启动 → arborist 把包及依赖装到全局缓存 `~/.cache/opencode/npm/...` → 解析并加载入口。

- V1 的单数写法 `"plugin"` 会被自动迁移成 `"plugins"`，两者都能用。

## 2. 包必须满足的形状

- **ESM**：`"type": "module"`。
- **`exports` 决定各入口**（依据 `@opencode/plugin` 的 `Host.resolve`，2.0.x 实测）：

  | 入口 | 解析规则 |
  | --- | --- |
  | server | 优先 `exports["./server"]`；否则回退 `exports["."]`；都没有则按约定 `index.js` |
  | tui | `exports["./tui"]`；否则按约定 `tui.js` |
  | rpc（可选） | `exports["./rpc"]` |

- **纯 TUI-only 包不会被加载**（关键坑）：只暴露 `exports["./tui"]` 时，server 侧 resolve 出 `server: undefined` → 整包被 server 跳过 → CLI 拿不到 → `./tui` 永远不加载，**且没有明显报错**（`plugin list` / `/api/plugin` 也看不到）。
  所以**即使只有 TUI 逻辑，也必须补一个 no-op server 入口**：

  ```json
  {
    "name": "opencode-acme-plugin",
    "type": "module",
    "exports": {
      "./server": "./src/server.ts",
      "./tui": "./src/tui.tsx"
    },
    "files": ["src"]
  }
  ```

- **server 入口绝不能碰 `context.ui`**（server 侧无 UI，会崩）。
- **`files` 必须覆盖 `exports` 指向的文件**（防止点目录/入口被 npm 打包剔除）。
- TUI 插件还需把 OpenTUI / Solid 声明为 `peerDependencies`（见官方 publish 文档）。

## 3. 版本、更新与卸载

- **钉版本（可复现，推荐）**：`github:owner/repo#v1.2.3`；不钉则跟随默认分支。
- 更新：`opencode plugin update <目标>`；卸载：`opencode plugin remove <目标>`。
  其中 `<目标>` 是**配置里那串 spec 原样**（如 `owner/repo` 或 `github:owner/repo#v1.2.3`），不是包名、不是路径。
- **Windows 坑**：未钉版本的 git 源在冷启动做更新检查时会 spawn `git ls-remote` 且未加 `CREATE_NO_WINDOW` → **弹出可见控制台窗口**（上游问题）。
  规避：钉完整 40 位 commit SHA（会跳过更新检查），或改用发现式安装。
- 想「自动更新且不弹窗」，用 **npm 包名**最稳 —— 走 registry HTTP，不 spawn git。

## 4. TUI 插件限制（重要）

- **根因**：配置安装会把插件放进 `node_modules`，而 npm v7+ 会**自动把 `peerDependencies`（`solid-js`、`@opentui/*`）装成插件自己的副本**。OpenCode/OpenTUI 的运行时模块桥接对 `node_modules` 下的 tsx 不生效 → 插件跑在**独立的 Solid 响应式图**上，宿主 store 的更新通知不到插件的 memo。
- **症状**：插件能画首帧，但**之后永不刷新** —— 例如侧边栏首次打开为空，**切一次会话/标签页才显示**。
- **上游 issue**：`#48883`（关闭为重复）、`#33884`（OPEN）、`#39986`（OPEN）。
- **规避**：TUI 插件改用**发现式安装**（把插件目录放到 `~/.config/opencode/plugins/<name>/`，即 `node_modules` 之外），桥接生效、响应式正常。

### 4.1 源码级根因

OpenCode 加载 TUI 插件时注册两个 Bun 插件（`packages/opencode/src/plugin/tui/runtime.ts` → `ensureRuntimePluginSupport`）：

| 链路 | 实现 | 对 `node_modules` |
| --- | --- | --- |
| Solid 转换器 | `@opentui/solid/scripts/solid-plugin.js`：onLoad 编译 JSX（`moduleName: "@opentui/solid"`），产物指向宿主运行时 | **不生效**——filter 明确排除 `node_modules` 下的 `.[jt]sx` |
| 运行时重写器 | `@opentui/core/runtime-plugin.js`：prescan + onLoad，把 import 重写为虚拟模块 `opentui:runtime-module:*` | 生效，但**只认源码文本里可见的 import specifier** |

**关键缝隙**：JSX 的 `import ... from "@opentui/solid/jsx-runtime"` 是 **Bun 转译 JSX 当时注入的**，源码文本里不存在 → 重写器的 prescan 看不到 → 不被重写 → 命中插件 `node_modules` 里那份 Solid → 第二套响应式图。

**推论**：出问题的只是 **JSX 那层**；`solid-js` 本身是源码里显式 import（文本可见），prescan 是**能**重写的。

### 4.2 TUI 插件要配置安装的三条路

| 方案 | 做法 | 自动响应式 | 构建链 | 状态 |
| --- | --- | --- | --- | --- |
| A 预编译 | 发布前用同一套 `babel-preset-solid`（`moduleName: "@opentui/solid"`）把 TSX 编译成 JS，使 jsx-runtime 的 import 以**文本形式**落进产物 → 被 prescan 重写 | ✅ | 需要 | 未实测 |
| B 不用 Solid | 命令式 `@opentui/core` renderable；入口 `import * as core from "@opentui/core"` 后**传参注入**，其余文件只 `import type`；刷新自己订阅驱动 | ❌（订阅驱动） | 无 | **已验证** |
| D 只用 solid-js 内核 | 保留 `createSignal`/`createEffect` 自动追踪，渲染走命令式 renderable（不用 JSX） | ✅ | 无 | 未实测 |

**结论：TUI 插件要支持配置安装，当前唯一已验证的做法是「不使用 Solid」（方案 B）。**
- 方案 B 活案例：`malhashemi/opencode-gpt-live`（npm 包 + `plugins` 配置加载，OpenCode ≥ 2.0.14；刻意不用 JSX/Solid）。

## 5. 验证方法（避免假阴性 / 假阳性）

- `opencode plugin list` / `GET /api/plugin` **不枚举「配置里的插件」** → 「没列出」是**无效信号**，不能据此判定加载失败。
- 真实加载看 **stderr**：`opencode api --standalone --print-logs GET /api/plugin`，观察 `msg="loading plugin"` 与 `WARN failed to load plugin ... cause`。
- 同名 spec（含 ref）的 git 安装会命中 `~/.cache/opencode/npm/git-*` 的**旧副本**，代码改了也不重拉 → 需清缓存或换 ref。
- `tui.json(c)` 的 `plugin` 字段在 `2.0.15` 上**未生效**（疑似更高版本才支持）；CLI 侧插件来源实际仍以发现式为准。

---

## 6. 对「我们自研 goal 插件」的启示

我们的 goal 插件是 **server 侧插件**（`/goal` 命令 + goal 工具 + idle 续跑 + 持久化），**不属于 TUI（Solid/JSX）插件**，因此：

1. **可以放心走配置安装**：用户只需在 `opencode.json(c)` 写一行 `plugins`，无需安装脚本、无需发 npm。
2. **包形状照第 2 节**：`type: module`；提供 `exports["./server"]`；`files` 覆盖入口；`server` 入口**不碰 `context.ui`**。
3. **分发策略**：
   - 想钉版本、可复现 → `github:owner/repo#v1.2.3` 或 `#<40位sha>`；
   - 想自动更新且不弹窗（Windows）→ 发 npm 包名；
   - 裸 `owner/repo` 会跟 main，并可能触发 Windows 弹窗。
4. **验证照第 5 节**：别信 `plugin list`；用 `api --standalone --print-logs` 看 stderr；改代码后注意清 `git-*` 缓存或换 ref。
5. **若将来要加 TUI 侧边栏**（像 prevalentWare 那样显示 goal 状态）：配置安装会踩「双 Solid」坑 → 要么走方案 B/D（不用 JSX），要么该 TUI 部分单独走发现式安装、与 server 包分开分发。

## 7. 参考文件

- 原始文档：`docs/config-install.md` @ `Just-Silver/opencode-tui-usage`
- 相关设计（已废止，回退脚本安装）：`docs/superpowers/specs/2026-09-24-config-install-design.md`、`docs/superpowers/plans/2026-09-24-config-install.md`
