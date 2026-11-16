# P3 删除 vendor 记录

- 日期：2026-11-16
- 阶段：**P3 完成**（P0/P1/P2 见 `docs/P0-依赖盘点.md`、`docs/P1-独立构建迁移记录.md`、`docs/P2-发布解耦记录.md`）
- 版本：v0.143.0
- 决策依据：用户 2026-11-16 明确「品牌 Electron 安装包 exe 不发，插件 tarball 要发」

## 1. 决策：发布物只有插件

| 资产 | 结论 |
|---|---|
| `starhub-windows-x86_64-<tag>.exe`（品牌 Electron 安装包） | **退役**。这条链要编译 `vendor/deepseek-harness/apps/desktop` 源码，上游没把桌面应用发布成 npm 包；每次上游发版都要整树同步+重放补丁（历史上反复把构建打红），且装机本身默认还是「没配 secret 就跳过」的半休眠状态 |
| `starhub-dsh-plugin-<版本>-win-x64.tgz`（插件 bundle：10 行 patch + 两个 sidecar + 工作台 dist） | **保留**，仍是 Release 主动产 |
| npm 上的 `@starhub/dsh-plugin@<版本>` | **保留**（有 `NPM_TOKEN` 时发布，插件页可原地更新） |

用户安装路径：**装官方 DeepSeek Harness → 插件页粘贴包名或 tarball**。

## 2. 这一步删掉的东西

| 删除项 | 原因 |
|---|---|
| `vendor/deepseek-harness/`（整棵，约 2.8 GB / 数千文件） | P1 已把所有 StarHub 自有源码迁出；上游按 npm 包消费。补丁面（`packages/sdk/server` 的 `sdk-transport`/`sdk-notifications`、`packages/client/runtime` 垫片）在 P1 已分别由 bridge 的 compat 层与 `packages/shims/client-runtime` 接管 |
| `release.yml` 的装机链 | Electron 打包、`apps/desktop/.env.windows` 物化、`DOWNLOAD_TEST_RELEASE_ID` / `DSH_DESKTOP_*` secrets、installer artifact 上传、publish job 的 exe 分支 |
| `scripts/provision-dsh.mjs` + `scripts/lib/provision-patch.mjs` + `tests/provision-dsh.test.mjs` | provisioning 只为「品牌安装包」把组合物化进 profile；bundle 形态自带 patch，不需要它 |
| `scripts/smoke-dsh-desktop.mjs` | 依赖自建 `dsh-runtime/`；插件冒烟已改打官方宿主（P2） |
| `scripts/verify-web-dist.mjs`、`build:web` 脚本 | 校验/构建 vendor 的 web 壳 dist |
| `package:dsh-runtime` 脚本 | 从 vendor 切便携运行时 |
| `profiles/starhub-web/`、`profiles/starhub-agent/` | 前者供自建运行时，后者是 Tauri 时代内嵌 runtime 的组合补丁，均无消费者 |
| `scripts/lib/` | 只剩 provisioning 用的补丁合并器 |

**保留** `profiles/starhub-desktop/cordis.patch.yml`：它是 10 个 bundle 行 id 的事实来源（`tests/plugin-bundle.test.mjs` 用它断言行 id 不可改名），也是一份可读的 desktop 组合示例。

## 3. release.yml 现在长什么样

```
tag v*.*.* → windows job:
  checkout → Node 24 / pnpm 10.15 / Go / Rust
  → npm ci + pnpm install --frozen-lockfile
  → test:utils + go test + cargo test
  → build release sidecars（Go + Rust）
  → build:lib + build:lib:client（★ 以前靠 vendor 的 package-dsh-runtime 顺带编，现在必须显式跑）
  → build:window
  → assemble plugin tarball（--pack）
  → tarball 内容校验（两个 sidecar / 工作台 dist / 客户端半边；不含 sourcemap、不含 tsbuildinfo）
  → 插件冒烟（真 pnpm add + 官方 dsh 宿主，五条断言）
  → 可选：npm 发布（有 NPM_TOKEN 时）
  → 上传 tarball artifact
→ publish job: 只判定/发布 tgz（没有 exe 分支）
```

> ★ 处同时修掉一个**潜在红灯**：以前 release 不跑 `build:lib`，靠 vendor 的运行时打包脚本顺带编出 `packages/starhub/*/lib`；vendor 一删，tarball 组装会直接 fail loud。现在显式跑，且 CI 已有同款步骤。

## 4. 验证（vendor 已不存在的情况下）

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `pnpm install --frozen-lockfile` | ✅ 不触碰 vendor |
| Host 编译面 | `npm run build:lib` | ✅ 0 错误 |
| Client 编译面 | `npm run build:lib:client` | ✅ 0 错误，`lib/client.js` + `lib/index.js` |
| 工作台 | `npm run build:window` | ✅ Vite 8 |
| 自有单测 | `npm run test:starhub` | ✅ 71 files / 1191 passed / 2 skipped |
| 其余单测 | `test:utils` / `test:plugin-bundle` / `test:workflows` / `test:migrate` / `test:ai-*` / `test:ssh-*` | ✅ 全绿 |
| 组装 | `npm run plugin:bundle` / `plugin:pack` | ✅ 目录形态 + tarball |
| 冒烟 | `npm run smoke:plugin-bundle` / `--spec <tgz>` | ✅ 五条断言（官方 `@deepseek-ai/dsh@0.2.2-rc.3`） |
| 活动代码/CI 无 vendor | `git grep -i vendor -- scripts/ tests/ .github/ package.json` | ✅ 仅剩解释性注释 |

## 5. 仍待做（不属于 P3）

1. **注册表发布 + 插件页原地更新验收**（需要 `NPM_TOKEN`；DSH 0.2.2+ 才有 Versions/Update）。
2. **P4**：SSH 接入宿主资源标签、浮动/停靠、会话绑定与生命周期（顺带恢复 `ssh-assistant` 那 2 条组合级用例）。
3. **P5**：数据库 / Docker / Android / 浏览器各自迁移到宿主工作区，随后退役 `apps/starhub-workbench` 的独立资产入口。
4. **平台矩阵**：目前只出 Windows x64（包内是两个平台相关的 sidecar）。Linux/macOS 要么拆平台包，要么首启下载（见 `docs/纯插件化-适配清单.md` C1）。
5. **历史文档**：`docs/` 里 M1–M4、DSH 升级清单等仍按当时上下文提到 `vendor/`，属历史记录不改；新事实以 P0–P3 四份记录为准。
