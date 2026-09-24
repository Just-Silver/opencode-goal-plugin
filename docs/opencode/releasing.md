# 发布（npm + GitHub Release）

> **版本单一来源**：`package.json` 的 `version`（本仓是单包仓库）。
> 发版硬性要求 **`tag == CHANGELOG == package.json`** 三处一致，由 `scripts/changelog.mjs check` 在 CD 里强制校验；
> **Release body 从 `CHANGELOG.md` 该版本小节截段**，禁止用 `git log` 拼。

## 0. 一句话

整理 `CHANGELOG.md` → bump `package.json` 的 `version` → 打 `vX.Y.Z` tag 并 push → `.github/workflows/release.yml` 自动跑
「测试 + 类型检查 + 版本一致性校验 + npm 发布（OIDC）+ 建 GitHub Release」。

流水线文件：

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push 到 `main`、PR | `bun test` + `tsc --noEmit` + 版本一致性（不含 tag） |
| `.github/workflows/release.yml` | **push tag `v*`** / 手动 | 测试 + 类型检查 + 一致性校验 + `npm publish`（OIDC）+ GitHub Release |

## 1. 发布凭据：npm Trusted Publishing（OIDC，无长期 token）

官方：<https://docs.npmjs.com/trusted-publishers>、CLI：<https://docs.npmjs.com/cli/v12/commands/npm-trust>

- 认证用 **OIDC**，**不需要** `NPM_TOKEN`；每次发布换取的是短期、限定工作流的凭据。
- 硬性前置：**npm CLI ≥ 11.5.1**（`npm trust` 要求 ≥ 11.15.0）、**Node ≥ 22.14.0**；流水线里用 Node 24 ✓。
- 工作流必须声明 `permissions: id-token: write`（`release.yml` 已声明，另有 `contents: write` 用于建 Release）。
- **provenance 自动生成**（OIDC + 公开仓库 + 公开包），**不要**加 `--provenance`，也**不要**在 `package.json` 写 `publishConfig.provenance`——后者会让「本地人工首发」因不在 CI 环境而失败。
- 支持的运行器只有 **GitHub 托管 runner**（自托管暂不支持）。

### 一次性配置（Trusted Publisher）

npm 侧要登记一条 trust 关系，字段**必须一字不差**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Just-Silver` |
| Repository | `opencode-goal-plugin` |
| Workflow filename | `release.yml`（只填文件名，含 `.yml`；**改名必须同步改这里**） |
| Environment name | **留空**（`release.yml` 里就没写 `environment:`；两边必须一致） |
| Allowed actions | **必须勾上允许 `npm publish`** |

> ⚠️ **2026-09-03 之后新建的 trust 配置默认只允许 `npm stage publish`**（暂存发布，需人工批准）。要直接发，必须显式允许 `npm publish`——用 CLI 时就是加 `--allow-publish`。

两种配置方式任选：

```bash
# 方式 A：CLI（npm >= 11.15.0；账号必须已开 2FA；GAT 的"绕过 2FA"与旧式 basic auth 都不被支持）
npm trust github @justsilver/opencode-goal-plugin \
  --file release.yml \
  --repo Just-Silver/opencode-goal-plugin \
  --allow-publish

# 查 / 删
npm trust list @justsilver/opencode-goal-plugin
npm trust revoke @justsilver/opencode-goal-plugin --id <trust-id>
```

方式 B：npmjs.com → 该包 → **Settings → Trusted Publisher** → 按上表填（Environment 留空、勾选允许 `npm publish`）。

> 官方提醒：npm **不会**在保存时校验这些字段，写错只有发布那一刻才报错（典型症状 `ENEEDAUTH`/`Unable to authenticate`）。
> 另一个必须满足的条件：`package.json` 的 **`repository.url` 必须与 GitHub 仓库完全一致**（本仓已设 `git+https://github.com/Just-Silver/opencode-goal-plugin.git`）。
> 发布步骤**不能**放进 `workflow_call` 复用的子工作流——那样校验的是**调用方**的文件名，会不匹配。

登记成功后建议加固：包 Settings → Publishing access → **Require 2FA and disallow tokens**（此后只有 trust 关系能发）。

## 2. 首次发布：必须先人工发一次

官方 `npm trust` 前置条件里明写 **"Package must exist"**，而没有包就没有 trust 配置可挂。所以 **0.1.0 必须人工发一次**（本地登录 + 2FA，不产生任何长期 token）：

```bash
npm login                       # 账号需已开启 2FA（npm trust 的硬性要求）
# 确认 package.json 的 version 与 CHANGELOG.md 小节一致：
node scripts/changelog.mjs check
npm publish                     # scoped 包，access 由 publishConfig.access=public 指定
```

然后按 §1 登记 trusted publisher。**此后所有版本都由 CD 发布。**

> 顺序很重要：先人工首发、再登记 trust、最后打 tag。
> 反过来（先打 tag）会让 CD 在 `npm publish` 处失败（没有 trust 关系；或版本已存在）。
> `release.yml` 的发布步骤是**幂等**的：registry 上已有该版本时只提示并跳过发布，因此首发之后再推同一个 tag 也不会炸。

## 3. 日常发版

```bash
# 1) 版本决策：fix → patch，feat → minor，破坏性变更 → major（0.x 阶段可随时破坏）
# 2) 把 CHANGELOG 顶部的 [Unreleased] 整理成新版本小节（含 ISO 日期），并 bump 版本号：
npm version patch --no-git-tag-version     # 只改 package.json，不自动建 tag/commit
git add -A && git commit -m "chore(release): v0.1.1"
# 3) 校验三处一致（本地先跑一遍，省得 CI 里才发现）
node scripts/changelog.mjs check --tag v0.1.1
# 4) 打 tag 并推送 → 触发 CD
git tag v0.1.1 && git push origin main && git push origin v0.1.1
```

CD 会：跑测试与类型检查 → 校验 `tag == package.json == CHANGELOG` → 从 CHANGELOG 提取 Release body → `npm publish` → 建/更新 GitHub Release（`vX.Y.Z`）。

## 4. 预检（不发布）

Actions → **Release** → **Run workflow**（`workflow_dispatch`）。它跑完整流程但发布步骤只执行 `npm publish --dry-run`，且**不建 Release** ⇒ 可以在正式打 tag 前验证打包内容与版本一致性。

## 5. 回滚

| 情形 | 动作 |
| --- | --- |
| tag 还没 push | 本地删掉重打：`git tag -d vX.Y.Z` |
| tag 已 push / 已建 Release | 先删线上 Release，再删远端 tag，再删本地 tag：<br>`gh release delete vX.Y.Z` → `git push --delete origin vX.Y.Z` → `git tag -d vX.Y.Z` |
| 版本已发到 npm 且有严重 bug | **发 patch 版**（`vX.Y.Z+1`）。已发布的版本号**永不复用**；npm 的 `unpublish` 受政策限制且会破坏下游依赖，不当回滚手段 |
| 用户已装坏版本 | 让他们改配置里的版本（`@justsilver/opencode-goal-plugin@<上一版>`）或 `opencode plugin update` 到修复版 |

## 6. 坑（官方文档 + 实测）

- **新包不能一步到位**：没有包 → 没有 trust 配置 → 首次必须人工发（见 §2）。
- **包名被占**：`opencode-goal`（别人的同类项目）与 `opencode-goal-plugin` 都已被占用；本包用作用域 `@justsilver/...`（作用域 = npm 账号名，天然归本人，无需建 org；若要用 `@just-silver`，得先在 npm 建同名 **org**）。
- **tag 与版本号不一致**：CD 会 fail 且**没有任何发布动作**；改完重打 tag 即可（tag 可删）。
- **trust 字段写错只在发布时报错**（npm 保存时不校验）——`ENEEDAUTH` 首先检查 workflow 文件名大小写与 `.yml` 后缀。
- **`CHANGELOG` 空小节/缺日期**：`scripts/changelog.mjs check` 会拦下（空小节不发版）。
- **npm 安装不弹 Windows 控制台窗口**（走 registry HTTP，不 spawn git）——这是相对 git 安装的额外好处，背景见 `known-issues.md` 的「上游问题跟踪」。
