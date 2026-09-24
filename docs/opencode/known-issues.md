# 已知问题 / TODO

> 只记**已定位、暂缓修复**的问题。每条要写清：现象 / 根因（含出处）/ 影响 / 建议修法 / 怎么验证。修完就删条目。

（本仓库自身当前没有已定位但暂缓的问题。）

> 已修的历史条目看 git 历史；对应的踩坑与实测方法沉淀在 `plugin-dev-gotchas.md` §8（会话删除事件 + 插件侧错误形状）。

---

## 上游问题跟踪（opencode 宿主侧，非本仓库可修）

> 不是本插件的 bug，但会影响我们的用户（尤其是我们推荐 git 安装之后）。**上游关闭并回归验证后删条目。**
> 早期记录来源：`Just-Silver/opencode-tui-usage` 的 `TODO.md` / `docs/config-install.md`；下面的根因我们**在宿主 v2 源码里重新核过**（2026-09-25）。

### [ ] #50868 未钉版本的 git 插件，冷启动更新检查会弹 Windows 控制台窗口

**现象**：`opencode.json(c)` 的 `plugins` 里写**未钉版本**的 git 源（如 `github:owner/repo`），opencode 共享服务 cold start 做插件更新检查时会 spawn `git ls-remote` —— **没设 `windowsHide` / `CREATE_NO_WINDOW`** → Windows 上弹出可见控制台窗口（一闪）。清掉 `~/.cache/opencode/npm/**` 后重启（触发强制重装）会弹更多次（上游报告实测 3 次）。

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

**影响**：README 推荐 git 安装 ⇒ 用户会遇到（只有钉死 SHA 才不弹）。

**规避（按推荐度）**：

1. **钉满 40 位 commit SHA**：上游明确 full commit hash 会跳过 update check → 完全不弹；代价是**没有自动更新**。本机全局配置就是这么装的。（**tag 是否同样跳过 —— 未验证**）
2. 别删 `~/.cache/opencode/npm/**`（删了会强制重装 → 弹更多次）。
3. 想「自动更新且不弹窗」：改用 **npm 包名**（走 registry HTTP，不 spawn git）；代价是要发到 npm（本插件目前不发）。
4. **发现式安装**（把插件目录放到 `~/.config/opencode/plugins/`）——本地开发时用的就是这条，无弹窗。

**动作**：

- [x] README 已写明：git spec 要 pin 40 位 SHA + Windows 弹窗提示（2026-09-25）
- [ ] 跟踪上游 #50868；上游关闭后回归验证（**去掉 pin** → `opencode service restart` → 看是否仍弹）
- [ ] 若上游长期不修：评估在 README 更醒目处提示，或改为推荐发现式 / npm 安装

**备注**：本插件自身**不 spawn 任何进程**（全仓 `child_process` / `spawn(` / `exec(` / `Bun.spawn` / `fork(` 均 0 命中；运行时 import 只有相对路径 + 宿主提供的 `@opencode/plugin` 类型），所以这个弹窗 100% 来自宿主 / 依赖层。
