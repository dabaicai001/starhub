# AGENTS.md — StarHub 协作指引

写给 AI Agent 和人类贡献者:读完这份文件就能上手改这个仓库。架构级变更请同步更新 `docs/` 与本文件。

## 项目是什么

StarHub 是 DevOps 桌面应用,单一窗口整合:数据库客户端(MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch)、SSH 终端、SFTP、Docker 面板、Android 真机、AI 助手。

**StarHub 不是桌面项目,是上游 DeepSeek Harness Electron 壳的外部插件集**:桌面壳、品牌/签名/更新栈都是上游的,StarHub 交付「插件 + 两个 sidecar 子进程 + 静态资产」三件套。去 Tauri 化(M1–M4)已把原来的 Tauri 壳整体退役,详见 `docs/去Tauri化-M1..M4-*.md` 四份清单。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/dabaicai001/starhub |
| 主分支 | `main` |
| 协议 | MIT |
| 当前版本 | v0.142.0(🔧 **P1 独立构建:StarHub 源码与构建链整体迁出 `vendor/deepseek-harness`**:10 个内置插件 → `packages/starhub/`、React 工作台 app → `apps/starhub-workbench/`（包名 `@starhub/workbench`）、`dsh-client-runtime` 垫片 → `packages/shims/client-runtime/`、profile 模板 → `profiles/`；仓库根新增自有 pnpm workspace 与两个 tsc 聚合面（`tsconfig.host.json` / `tsconfig.client.json`），编译改用官方已发布 `@deepseek-ai/dsh-*@0.2.2-rc.3`（cordis `~4.1.0` / schemastery `~3.19.0`），不再读取 vendor 源码树。客户端半边与工作台改为自建构建（`scripts/build-client-bundle.mjs` 用 esbuild 做 CSS Modules 作用域化 + 样式内联 + `__ModuleLoader__.load` 包装；`scripts/build-window.mjs` 改用 Vite Node API）。代码侧只动了「把私有补丁换成本地定义」的 5 处：`sdk-notifications` 类型改从 `@deepseek-ai/dsh-starhub-bridge/compat` 导入（bridge 增开该子路径）、`client-nav` 补 settings controller 的 remote 类型合并、`Menu` 的右键锚点从 `getAnchorRect` 改 `anchorPoint` + `contextual`、bridge 补齐 schemastery / host-webserver 依赖。运行期契约（包名、行 id、服务名、路由、sidecar 名、settings 命名空间、`engines.dsh`）一字未改。详见 [docs/P1-独立构建迁移记录.md](docs/P1-独立构建迁移记录.md)。) |

## 架构一句话

三层进程:**上游 Electron 壳(零改动)** 跑 dsh Host(Node)进程 → Host 里的 **starhub-bridge 插件** spawn 两个 sidecar:**Rust sidecar(`sidecar-rust/`,ssh/sftp/android/browser 契约层 + 直播帧枢纽)** 与 **Go Sidecar(`sidecar/`,数据库/中间件适配)**,均经 stdio 换行分帧 JSON-RPC 通话 → **前端**是 DSH 主壳 + StarHub React 工作台(`packages/starhub/client-nav` 的客户端半边 + `apps/starhub-workbench` 的独立资产入口;**P1 起 StarHub 自有源码不在 vendor 里**)。

## 目录结构

```
starhub/
├── sidecar-rust/           # Rust sidecar(M1 起域逻辑的新家)
│   └── crates/
│       ├── starhub-sidecar      # 二进制 + stdio JSON-RPC 方法面(模型面 + ui.* 面)
│       ├── starhub-live         # 直播/接管帧枢纽(M3):本地 WS + Android 帧源
│       ├── starhub-contract     # 领域事件 schema + 模型可读能力文本
│       └── starhub-domain-{ssh,db,android,browser}
│
├── sidecar/                 # Go 1.25 Sidecar — 数据库/中间件代理
│   ├── main.go               # stdio JSON-RPC server 入口
│   ├── adapters/             # mysql / postgres / sqlite / redis / clickhouse / mssql /
│   │                         # elasticsearch / broker(Kafka/NSQ)/ docker(+compose,+ssh)/ csv / backup
│   ├── pool/  rpc/           # 连接池 / JSON-RPC 协议
│   └── bin/                  # 构建输出 starhub-sidecar[.exe]
│
├── packages/                # StarHub 自有 workspace(P1 起;P1 详情见 docs/P1-独立构建迁移记录.md)
│   ├── starhub/             # 10 个内置插件:approval-bridge / bridge / client-nav /
│   │                        # domain-events / host-static / live-context /
│   │                        # session-registry / ssh-assistant / tool-context / tools
│   └── shims/client-runtime # @deepseek-ai/dsh-client-runtime 兼容垫片(上游已删该包,整体是 StarHub 的)
│
├── apps/starhub-workbench/  # React 工作台独立资产入口(Vite,产物 dist-starhub-react/,base=/starhub-react/)
├── profiles/                # profile 组合模板:starhub-desktop / starhub-web / starhub-agent
├── pnpm-workspace.yaml      # StarHub 自己的工作区(packages/*/*、apps/*)
├── .npmrc                   # node-linker=hoisted(声明文件可移植性,见 docs/P1 迁移记录)
├── tsconfig.{base,base.client,host,client}.json  # 两个编译聚合面,官方包从 node_modules 解析
│
├── vendor/deepseek-harness/ # 上游 deepseek-ai/deepseek-harness 的 vendored 副本(随仓库版本化;
│                            # 上游 commit 记录于 vendor/deepseek-harness/UPSTREAM_COMMIT.txt)。
│                            # P1 起 StarHub 自有源码已全部迁出,这里只剩上游本体 + 发布链用的 Electron 壳;
│                            # P2/P3 决定自建壳产物去留后整棵删除。
│   ├── apps/                # web / cli / desktop / desktop-host(上游自家应用)
│   └── packages/            # 上游全部包(StarHub 只经 npm 已发布包消费它们)
│
├── scripts/
│   ├── provision-dsh.mjs     # M4:把 StarHub 组合装进 dsh profile
│   ├── smoke-dsh-desktop.mjs # M4:provisioning + 宿主进程冒烟
│   ├── build-plugin-bundle.mjs  # 纯插件形态:拼出自包含 bundle(→ dist-plugin/,--pack 出 .tgz)
│   ├── smoke-plugin-bundle.mjs  # 纯插件形态:pnpm 安装 + 宿主冒烟(五条断言)
│   ├── build-sidecar.*       # Go sidecar 构建
│   ├── build-window.mjs      # React 工作台构建
│   ├── bump-version.mjs      # 版本号同步
│   ├── cargo-sidecar.bat     # Windows 上跑 sidecar-rust 的 cargo(MSVC + 工具链)
│   └── cargo-sidecar.mjs     # 上面的跨平台包装:Windows 转 .bat,其它平台直调 cargo
│
├── dsh-runtime/             # 打包好的 dsh 运行时(gitignore;package:dsh-runtime 产出)
├── dist-starhub-react/      # React 工作台产物(gitignore)
├── dist-plugin/             # 纯插件 bundle 组装产物(gitignore;plugin:bundle 产出,--pack 另出 .tgz)
├── docs/                    # 技术方案 / 设计系统 / 踩坑记录 / 已知坑索引 / 去Tauri化 M1-M4 清单
├── test-sftp/               # SSH/SFTP stub + 桥兼容验收脚本
└── tests/                   # node --test 单测(utils、AI 上下文/滚动/记忆、SSH prompt/cwd/后台任务、provisioning)
```

## 技术栈速查

- **前端**:React + TypeScript 5(strict)+ Vite 5;xterm.js 6(终端)、CodeMirror 6(SQL)、zmodem.js
- **Rust**:tokio、russh 0.62 + russh-sftp 2、serde、thiserror/anyhow;sidecar-rust 是独立 workspace(零 tauri 依赖,`cargo tree` 不应出现 tauri crate)
- **Go**:go-sql-driver/mysql、jackc/pgx、modernc.org/sqlite(纯 Go)、go-redis、clickhouse-go、go-mssqldb、go-elasticsearch、docker/docker、zerolog
- **Node**:上游 dsh Host(desktop profile)+ starhub-bridge 插件。**仓库根是 StarHub 自己的 pnpm workspace**(`packages/*/*` + `apps/*`),devDependencies 只有工具链(typescript / tsx / esbuild / vite / js-yaml);每个 StarHub 包按需声明官方 `@deepseek-ai/dsh-*@0.2.2-rc.3`(编译期类型与运行期宿主供给)与 `@deepseek-ai/cordis@~4.1.0` / `@deepseek-ai/schemastery@~3.19.0`。根 `scripts/` 与 `tests/` 只 import node 内置模块。

**铁律 — 新功能优先以 dsh 插件形式注入,不改上游内核源码。** 新能力落在 `packages/starhub/*`(P1 起 StarHub 自有源码在这里,不在 vendor),经槽位系统(`ctx.slots.register` / `slots.inject`)或 Cordis 服务(`ctx.provide` / `ctx.get`)接入。上游内核要么用已发布 npm 包,要么在 `vendor/` 里只做「修 DSH 自身 bug(注释标注上游补丁)」这类最小改动 —— 而 P3 之后 vendor 不存在,这条路径也随之消失。不新增 Vue 系依赖。

## 关键命令

```bash
npm install && pnpm install     # 根 workspace 装依赖(StarHub 自有包 + 官方 @deepseek-ai/dsh-*)

npm run build:lib            # Host 面:官方包类型下编 9 个 host 插件 → lib/types/
npm run build:lib:client     # Client 面:client-nav 的 tsc + 自建客户端半边(lib/client.js / lib/index.js)
npm run build:window         # 构建 React 工作台(→ dist-starhub-react/)
npm run clean:lib            # 清掉上面几步的产物
npm run sidecar:build        # Go Sidecar(加 :release 为 release 构建)
npm run sidecar-rust:build   # Rust sidecar(scripts/cargo-sidecar.mjs:Windows 转 .bat 加载 MSVC,其它平台直调 cargo)

npm run test:utils           # node --test 纯逻辑套件;其余套件见 package.json scripts
npm run test:provision       # provisioning 合并逻辑单测
npm run smoke:dsh-desktop    # provisioning + 宿主进程冒烟(五条断言)
npm run plugin:bundle        # 纯插件形态:组装 dist-plugin/(加 --pack 出 .tgz,粘进 dsh 插件页)
npm run plugin:pack          # 同上并打 tarball(Windows PowerShell 下 `npm run x -- --pack` 会被吞参,故单列一个脚本)
npm run plugin:publish       # 把组装好的 bundle 发到注册表(DSH 0.2.2+ 插件页原地更新;先 --dry-run 验)
npm run smoke:plugin-bundle  # 纯插件形态:真 pnpm 安装 + 宿主冒烟(五条断言)
npm run verify:bridge-compat # 真 sidecar 二进制 ↔ 桥兼容层全工具面验收
npm run verify:ai-cancel     # 「停止生成」真链路验收:运行中关闭通道 / 排队中不下发 / 连接仍可用

npm run package:dsh-runtime  # 打包 dsh 运行时(→ dsh-runtime/)
npm run provision:dsh        # 把 StarHub 组合装进一个 dsh profile
npm run version              # 版本号同步(见下)

# 上游 Electron 壳(发布链)
pnpm --dir vendor/deepseek-harness/apps/desktop run package:win:x64:unsigned
```

## 开发约定

**提交信息**:Conventional Commits + emoji 前缀:`✨ feat` / `🐛 fix` / `📝 docs` / `🔧 chore` / `⬆️ upgrade` / `⚡ perf` / `✅ test` / `🎨 style` / `♻️ refactor` / `🗑️ remove`,格式 `<emoji> <type>(scope): <subject>`。一次 commit 只装一个主题。

**分支**:`main` 主干;`feat/<name>` / `fix/<name>` / `docs/<name>` / `refactor/<name>` / `release/v<x.y.z>`。

**代码风格**:TS `strict`、禁 `any`(用 `unknown`);Rust 过 `cargo fmt` + `clippy`;Go 过 `gofmt`;公共 API 写文档注释;面向用户文案走 i18n,禁硬编码;全仓库 UTF-8 无 BOM。

## 版本与提交纪律(强制)

1. **改完立即 commit + push**:工作区不允许长期挂未提交改动;不把自己的改动和用户已有的未提交改动塞进同一个 commit(diff 不干净时只 commit 自己审过的部分,其余明确告知用户)。
2. **代码或构建链改动必须升版**,纯文档改动(docs/、README 正文、注释)免升版。判断标准:会不会改变打包产物或用户可感知行为?不会 → 免升版;拿不准 → 升。
3. **升版同步四处**(M4 退役 src-tauri 之后从七处降下来):`package.json`、`CHANGELOG.md`、`AGENTS.md`(本节「当前版本」)、`README.md`(版本 badge)。`npm run version` 一键搞定。
4. **版本号规则**:主版本 = 架构不兼容变更;次版本 = 新功能;修订版 = bug 修复 / 小改进 / 构建脚本调整。
5. **CHANGELOG**:改动在 `[未发布]` 下补条目,发布时移到 `[x.y.z] - YYYY-MM-DD` 下。
6. **tag 与 Release**:`release.yml` 由 `v*.*.*` tag 触发;一次 push 最多触发 3 个 tag,超出静默丢弃;多版本只在最后推最新 tag,单个推(`git tag vX.Y.Z && git push origin vX.Y.Z`);纯文档修订版不打 tag。

## 测试

| 层 | 工具 | 命令 |
|---|---|---|
| 前端纯逻辑 | node --test | `npm run test:utils` 等(见 package.json scripts) |
| 前端组件 | Vitest | `vendor/deepseek-harness` 内的上游包测试(StarHub 自己的包已迁出,单测仍待 P2 迁) |
| Rust | cargo test | `npm run sidecar-rust:test`(Windows)/ `cargo test --manifest-path sidecar-rust/Cargo.toml` |
| Go | go test | `cd sidecar && go test ./...` |
| 发布链 | node --test + 冒烟 | `npm run test:provision` + `npm run smoke:dsh-desktop` |

## 文档维护(强制)

架构级变更必须同步:`docs/技术方案.md`、`docs/架构图.html`、`CHANGELOG.md`、本文件。已知坑沉淀到 `docs/踩坑记录.md`,主题索引在 `docs/已知坑索引.md`。

## 协作 Tips

- **改文档前先读**:`docs/技术方案.md` 是事实来源,代码与文档冲突时先更新文档。
- **跨域改动要协调**:加数据库支持 = `sidecar/adapters/` + 技术方案文档 + 技术栈表;加 SSH 能力同理。
- **安全 / 性能 / 架构决策**先开 Issue 讨论,不独自拍板。
- **不确定时**优先遵循 `docs/技术方案.md`;文档没写的沿用主流方案 + 开 Issue 提案,不凭直觉造新架构。

---

*最后更新: 2026-11-16 (v0.142.0)*
