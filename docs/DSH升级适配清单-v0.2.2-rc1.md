# DSH 升级适配清单 — v0.2.2-rc.1(插件页原地更新)

> 上游基线:`vendor/deepseek-harness` 仍钉在 `dsh-v0.2.1-alpha.1`;本机桌面壳已装
> DSH **0.2.2-rc.1**(`D:\deepseek-harness\resources\app.asar` 内
> `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`)。
>
> 本文只记录 **0.2.2-rc.1 的插件更新能力**对 StarHub 纯插件形态的影响与已落地的适配;
> 不涉及 vendor 源码升级(仓库仍以 0.2.1 编译/冒烟,新增能力按「旧运行时也能装、
> 新运行时才能更新」处理)。

---

## 一、上游事实(0.2.2-rc.1)

### 1.1 更新准入:`updatable`

`@deepseek-ai/dsh-plugin-manager` 的 `listBundles()` 给每个 bundle 计算
`updatable`,由 `updateRefusal()` 判定(源码 `lib/index.js` / `lib/types/index.js`):

| 条件 | 说明 |
|---|---|
| `installed` + `availability === 'profile'` + 非 `official` | 必须是 profile 自己声明的第三方包;随安装出货的 bundle 不参与 |
| 无 `readOnlyReason` | 携带插件管理的包不可移除,也不可替换 |
| 版本是合法 semver | 版本列表按 semver 比较新旧 |
| `source` 解析为 **registry** 且 `parsed.name === bundle.name` | profile `dependencies` 里必须按**本名**保存注册表 spec |
| `parsed.range` 不含 `:` | `npm:` 别名、`file:`/`git:`/`link:` 等协议都不算注册表 spec |

实际结果:

| profile 依赖写法 | 可更新 |
|---|---|
| `"@starhub/dsh-plugin": "0.140.5"` | ✅ |
| `"@starhub/dsh-plugin": "^0.140.0"` | ✅(更新会改写为精确版本) |
| `"@starhub/dsh-plugin": "https://github.com/.../x.tgz"` | ❌(当前安装形态) |
| `"@starhub/dsh-plugin": "file:../dist-plugin"` | ❌ |
| `"@starhub/dsh-plugin": "git+https://..."` | ❌ |
| `"@starhub/dsh-plugin": "npm:other@1.0.0"` | ❌ |

### 1.2 更新流程

- `listVersions(name)`:对 `updatable` 的包跑 `pnpm view <name> versions time dist-tags`,
  再逐个版本读 `engines` / `peerDependencies` / `dsh` / `deprecated`;按
  `engines.dsh` 与 DSH peer 判兼容,不兼容的版本标出来但不提供 Update。
- `updateBundle(name, version)`:先按 `listVersions` 同样的计划做 `check`(缺版本、
  无 `dsh.bundle`、`engines.dsh` 或 DSH peer 不兼容都在这一步拒绝且 profile 不变),
  然后**移除已安装版本 → 安装 `name@version`(saveExact)+ 当前启用选择**;
  失败/取消会尝试重装旧版本(`restore`),再失败才留下未安装。
- 有 HMR 时先卸载旧包(插件停止、模块驱逐)再安装;无 HMR 时覆盖安装并报
  `restart-required`。
- 事件:`plugin-manager/update-state`(`checking` / `removing` / `installing` /
  `restoring`),安装日志继续走 `plugin-manager/install-log`。

### 1.3 UI 表现(插件页)

- 只有 `updatable` 的第三方 bundle 才有 **Versions** 区块:打开详情触发一次检查,
  可手动 **Check again**;摘要显示「有新版本 / 已是最新 / 需要先升级 DSH / 检查失败」。
- 有新版时卡片出现 **Update available**,详情头出现 **Update to**;确认框展示
  当前版本、目标版本、安装注册表与失败回滚语义。
- 从 link / 本地路径 / git / tarball 安装的包**没有 Versions 区块**;Official
  bundle 跟随 DSH 版本,也不参与。

### 1.4 平台声明

- `dsh.bundle.platforms`(数组,值为 `process.platform`)在保存启用选择前检查;
  不支持的主机会返回 `unsupported-platform`,插件页隐藏/拒绝启用。
- npm 侧对应字段是 `os` / `cpu`;两者要一致,否则用户在 mac/Linux 上会装到一个
  跑不起来的包。

---

## 二、StarHub 原形态与差距

原发布形态(`scripts/build-plugin-bundle.mjs`):

- 生成 `dist-plugin/package.json`,声明 `private: true`、`dsh.bundle.patch`,
  没有 `license` / `engines` / `os` / `cpu` / `publishConfig`;
- 发布链只产 `starhub-dsh-plugin-<ver>-win-x64.tgz` 并挂 GitHub Release;
- 用户在插件页粘贴 **tarball URL** 安装,profile 依赖因此是 URL → `updatable=false`,
  升级只能卸载重装;
- 包内没有 README,插件页详情文档为空;
- 两个 sidecar 随包分发,包体是 Windows/x64 专用,但清单没有平台声明。

差距一句话:**包能装,但不是「注册表包」,所以新版 DSH 的更新链路完全够不到它。**

---

## 三、已落地适配

### 3.1 清单可发布、可更新(必须项)

`renderManifest()` 生成:

- 去掉 `private: true`(npm 拒绝发布私有包,DSH 也不会把它当可替换的第三方包);
- 补 `license: MIT`、`repository`、`homepage`、`keywords`;
- `engines.dsh: ">=0.2.1"`(0.2.1 可安装;原地更新由 0.2.2 的运行时能力决定);
- `os: [构建平台]`、`cpu: [构建架构]`,与 `dsh.bundle.platforms` 一致;
- `publishConfig.access: "public"`;
- `files` 增加 `README.md`;
- 生成包内 `README.md`(插件页详情文档),写清注册表安装/原地更新/tarball 无更新。

`assertBundle()` 追加 `publishabilityProblems()`:private、非 semver、缺 license /
engines / 平台声明 / README、或带 `dependencies` / `peerDependencies` 都在组装期
fail loud,不会产出「能装但发不出去/更新不了」的包。

### 3.2 发布链

- 新增 `scripts/publish-plugin-bundle.mjs`(`npm run plugin:publish`):
  先按 `publishabilityProblems` + `assessUpdateEligibility` 校验,再
  `npm publish --access public --tag <tag>`;版本已存在时跳过(可用 `--force`);
  `--dry-run` 供 CI/本地验证。
- `release.yml` 与 `plugin-bundle.yml` 在 smoke 通过后:
  - 检测 `secrets.NPM_TOKEN`;没有则 warning 跳过(tarball 仍发布);
  - 有则 `npm config set registry` + `//<host>/:_authToken`,再执行发布脚本。
- 包名可由仓库变量 `STARHUB_PLUGIN_PACKAGE_NAME` 覆盖(默认
  `@starhub/dsh-plugin`);注册表可由 `STARHUB_PLUGIN_REGISTRY` 覆盖
  (默认 `https://registry.npmjs.org`),支持私有 registry。
- tarball 资产名与内容校验保持原样,新增 `package/README.md` 必检项。

> 公开 npm 上 `@starhub` scope 需要归属。未配置 scope/token 时,发布链仍产 tarball,
> 用户仍可从 Release 安装,只是没有 Versions/Update;配置后同一份产物即可原地更新。

### 3.3 工作台静态资源(顺带优化)

`host-static` 的 `/starhub-react`:

- Vite 内容哈希资产(`assets/<name>-<hash>.<ext>`)返回
  `cache-control: public, max-age=31536000, immutable`;`index.html` 与未哈希文件
  `no-cache`。更新后不会拿旧入口对不上新 hash。
- 缺失的**带扩展名**路径返回 404,不再回落 `index.html`(避免浏览器把 HTML 当 JS
  缓存);无扩展名的 SPA 路由仍回落入口。
- `HEAD` 只发头;非法百分号转义返回 400;补齐常见 MIME(webp/avif/woff/ttf/
  webmanifest/wasm 等)。

### 3.4 更新安全(顺带优化)

`bridge`:

- sidecar 的生命周期 disposer 在 spawn 成功后**立刻**登记;后续 `ctx.provide` /
  路由注册抛错(如 duplicate `sdk-transport`)会先收进程再抛出,避免加载失败后
  sidecar 占着 exe,Windows 上导致更新时 `pnpm remove` 失败。
- spawn 加 `windowsHide`;健康探针失败与 dispose 都等待子进程真正退出(2s 后
  SIGKILL),减少文件占用窗口。

---

## 四、验收

| 项 | 命令/证据 |
|---|---|
| 清单/更新准入单测 | `npm run test:plugin-bundle`(12 例,含注册表 vs tarball/git/别名、private/README 拦截) |
| host-static | `pnpm --dir vendor/deepseek-harness exec vitest run packages/starhub/host-static`(8 例,含缓存/404/HEAD/405) |
| 组装 | `node scripts/build-plugin-bundle.mjs --pack`(会打印注册表安装 spec 与更新提示) |
| 发布 dry-run | `node scripts/publish-plugin-bundle.mjs --dry-run` |
| 真安装/宿主 | `npm run smoke:plugin-bundle -- --spec <tgz>`(五条断言不变) |
| 发布后 | 插件页 → StarHub → Versions → Update;失败应回到原版本 |

---

## 五、仍挂着

1. **npm scope/包名归属**:`@starhub` 需要组织权限;换名只改 `--name` / 仓库变量,
   但**已装用户的 profile 依赖名会变**,需要卸载重装一次。
2. **平台矩阵**:当前只有 Windows x64 的 sidecar;mac/Linux 要么按平台拆包(同名包
   无法容纳多平台二进制),要么改首启下载 + 校验和。
3. **旧安装迁移**:tarball 安装的存量用户不会自动出现 Update;需要卸载后按包名安装
   一次,之后才进入原地更新轨道。
4. **vendor 仍为 0.2.1**:本地冒烟验证的是「旧运行时能装」;更新 UI 的端到端验证需要
   桌面壳 0.2.2-rc.1(本机已具备)。
5. **`engines.dsh` 下限**:目前 `>=0.2.1`;若后续用到 0.2.2 才有的宿主 API,再抬到
   `>=0.2.2`。

---

*最后更新:2026-11-06(v0.140.5)*
