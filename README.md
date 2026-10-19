<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

*数据库 · 终端 · 文件 · 容器 · 真机 · AI —— 收进同一个窗口*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.136.6-cyan)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20首发%20%7C%20macOS%20%2F%20Linux%20规划中-blue)]()
[![Downloads](https://img.shields.io/badge/downloads-GitHub%20Releases-blue)](https://github.com/dabaicai001/starhub/releases)
[![官网](https://img.shields.io/badge/官网-starthub.waouzzz.cc-cyan)](https://starthub.waouzzz.cc/)

</div>

你的桌面上一半是"生产力工具":Navicat 连库、Xshell 开终端、WinSCP 传文件、Portainer 看容器、网页里挂着个 AI 对话框——每天在五六个窗口之间来回切,复制粘贴当"集成"。StarHub 把这些收进**同一个窗口**:左边是资产,中间是工作台,AI 在侧栏待命——`@` 一下把服务器交给它,`#` 一下把日志贴给它;它每一次动手,都要先弹一张确认卡问你。

不是把五个图标摆进一个启动器,而是让它们共享同一套资产、同一条连接、同一份 AI 上下文。

官网:[starthub.waouzzz.cc](https://starthub.waouzzz.cc/)

## 为什么是 StarHub

| 痛点 | 别人的做法 | StarHub 的做法 |
|---|---|---|
| 工具多 | Navicat + Xshell + Portainer + 资源管理器同时开 | 一个窗口:数据库 / SSH / SFTP / Docker / Android / AI |
| 连接碎 | 终端连一次、SFTP 再连一次、Docker 又配一套 | SFTP 与终端共用同一条 SSH 连接;Docker 可经 SSH 通道连远程主机 |
| 上下文丢 | 操作 A 时被 B 打断,错误信息靠人肉搬运 | 同屏三栏、命令广播;`@` 绑资产、`#` 绑上下文直接喂给 AI |
| AI 只会聊天 | 问答归问答,执行归执行 | Function Calling 直连真实资产,自然语言 → 自动拆解 → 跨工具执行 |
| 操作不可追溯 | 出了事翻聊天记录 | 写操作必经确认卡(超时按拒绝),全程落审计日志;真机直播可回放 |

## 功能

**数据库**:MySQL、PostgreSQL、SQLite、Redis、ClickHouse、SQL Server、Elasticsearch。表结构浏览、SQL 编辑器(CodeMirror 6,补全/格式化/历史)、虚拟滚动结果网格(可编辑、按主键批量保存)、DDL 生成、监控 Dashboard、Excel 导入导出、备份恢复、审计与告警。Oracle / MongoDB / 国产库 ODBC 在规划中。

**SSH 终端**:xterm.js 6,跳板机、端口转发、分屏、命令广播、危险命令拦截、ZMODEM(rz/sz)、Xshell 快捷命令导入、MFA/2FA、cwd 跟踪、断线重连。命令面板(Ctrl/⌘+K)、输出查找、主机监控页签、终端设置浮层一应俱全。

**SFTP**:与终端共用同一条连接,三栏浏览、拖拽传输、断点续传、暂停/继续、全局传输任务条。

**Docker**:容器/镜像管理、交互式 Exec TTY、日志查看、Compose、支持经 SSH 通道连远程 Docker 主机。

**AI 助手**:OpenAI 兼容协议(可接 GPT / Claude / DeepSeek / Ollama 等),Function Calling 直接驱动 SSH / 数据库 / SFTP / Docker / 本地文件 / Android 真机等工具;`@` 绑定资产、`#` 绑定上下文;三级记忆卡 + 会话全文存档;所有 AI 发起的写操作都要经过确认卡审批并落审计日志。

**Android 实体机直连**(adb):AI 直接操作用户真实的 Android 手机(开发者模式 → USB 调试 / 无线调试)——截屏看画面、点按/滑动/滚动、按键、输入文本、按包名启动 App、设备文件传输、无线配对,共 19 个 `android_*` 工具;直播画面在壳内直播面板里看(scrcpy-server 的 H.264 实时,不可用自动降级截图轮询),支持围观/接管;任务级授权(60 分钟)、任意 shell 恒确认 hard 档、每次写操作自动截屏留档可回放——真实设备,每一步都有据可查。

**其他**:Kafka/NSQ 元数据、深浅双主题、自动更新。

## 架构

三层进程模型:

- **上游 Electron 桌面壳** — DeepSeek Harness 自家的 Electron 壳,**零改动**原样使用;品牌、签名、自动更新都是它的。StarHub 不做自己的桌面项目。
- **dsh Host + starhub-bridge 插件** — Host(Node)进程里的 bridge 插件 spawn 两个 sidecar,把 sidecar 的方法面暴露成模型工具与工作台命令面。
- **两个 sidecar** — **Rust sidecar**(`sidecar-rust/`)承载 SSH/SFTP、Android 真机与直播帧枢纽;**Go Sidecar**(`sidecar/`)承载 MySQL / PostgreSQL / SQLite / Redis / ClickHouse / SQL Server / Elasticsearch / Docker / Kafka 等适配器和连接池。均经 stdio 换行分帧 JSON-RPC 通信。
- **前端** — DeepSeek Harness(dsh)主壳,StarHub 的工作台和插件住在 `vendor/deepseek-harness` 里:`apps/starhub-window` 是资产工作台构建入口,`packages/starhub/*` 是 10 个内置插件(导航、工具桥、直播、审批、领域事件等),经 dsh 的槽位系统接入,不改上游内核。

## 当前版本

### v0.136.6 (2026-10-19)
- 🐛 🐛 **数据库页两处 P0 前后端契约错位(在真实 sidecar 上直接失败,单测因沿用旧参数名而漏掉)**:① 单元格编辑保存走 `db_mysql_update_rows` 时前端仍发旧 Tauri 时代的 `whereClause`——去 Tauri 化后的 Rust 转发层是纯平铺转发、参数白名单只认 `where`,于是每次保存都被「缺少 where」拒绝,单元格编辑实际从未保存成功;② Redis key 搜索把 SCAN 的 MATCH 模式发成 `matchPattern`,sidecar 的 `db.redis.scan` 只解 `match`,搜索词被静默丢弃、返回整库 key(搜索框形同虚设)。两处均改为 sidecar 契约参数名,并补回归断言。
- 🐛 🐛 **数据工作台跨库同名表串数据**:字段树展开态/列详情只按表名缓存,`app.users` 与 `other.users` 共用一份列;删表会把所有库里的同名表一起从树里抹掉。现在缓存键改为「库.表」,删表只作用目标库,并关闭该表的打开标签页。
- 🐛 🐛 **Redis 值编辑器类型与采样**:① 以服务端 `get_value` 的 type 为准——被删/过期的 key 不再渲染成文本 `null` 且可保存(凭空重建 key),而是明确「Key 不存在」并禁用保存/TTL;缓存类型过期(如 string 实为 hash)时按真实类型渲染。② 大集合只回传前 N 项时提示「仅加载前 N 项(共 M 项)」,不再把这些可见项删完误报「保存后集合为空」。③ key `a` 与同名文件夹 `a`(来自 `a:b`)共存时渲染 key 重复,补节点种类前缀。
- 🐛 🐛 **DB 工作台交互**:清空当前打开的表后网格不刷新(仍显示旧行);点库行不设为执行库(与库行 title/选择器提示不符);非安全上下文无剪贴板时点 DDL「复制」会对 undefined 取 `.then` 抛错;Redis 连接失败错误条只有「返回」,只能关窗重开——现在可原地重试。
- 🐛 🐛 **DB 监控面板错过连接就绪**:面板在连接建立前挂载(连接中切「监控」)时,旧 effect 只看 connId/dbType,connected=false→true 不触发加载,指标永远停在初始值。
- 🔧 🔧 **数据库页细节完善**:结果网格行号改为全局偏移(第 2 页从 101 起),空页显示空态并区分「当前页没有数据 / 当前筛选没有匹配的行」;Redis 连接失败可原地「重试」;删表时自动关闭该表的数据标签。

> 历史版本见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载

[GitHub Releases](https://github.com/dabaicai001/starhub/releases) 提供:

| 平台 | 产物 |
|---|---|
| Windows | NSIS `.exe`(未签名) |

> **Linux / macOS 暫不发版(2026-10-09 决策 A:等上游)**。桌面壳是上游 DeepSeek Harness 的 Electron 壳,它的 `SUPPORTED_TARGETS` 目前只有 `mac-arm64` / `mac-x64` / `win-x64`,没有 Linux target;原来的 deb/rpm 能力随 Tauri 壳一起退役。等上游出了 Linux target,加一个 CI job 即可,StarHub 不自己维护第二条打包路径。macOS 同理(缺签名/公证证书,证书就位后照抄 Windows job 改 target 名)。

## 开发

前置:Node 20 LTS、Rust 1.96+、Go 1.25+、pnpm 11+。Windows 需要 MSVC 构建环境。

```bash
git clone https://github.com/dabaicai001/starhub.git
cd starhub
npm install
pnpm --dir vendor/deepseek-harness install

npm run build:window && npm run sidecar:build && npm run sidecar-rust:build
npm run smoke:dsh-desktop   # provisioning + 宿主进程冒烟(五条断言)
```

常用命令:

| 命令 | 作用 |
|---|---|
| `npm run build:window` | 构建 React 工作台(输出 `dist-starhub-react/`) |
| `npm run sidecar:build` / `:release` | 构建 Go Sidecar |
| `npm run sidecar-rust:build` / `:test` | Rust sidecar 构建 / 测试(Windows 自动加载 MSVC) |
| `npm run test:utils` 等 | Node `node --test` 纯逻辑测试(见 `package.json`) |
| `npm run test:provision` | provisioning 合并逻辑单测 |
| `npm run smoke:dsh-desktop` | provisioning + 宿主进程冒烟 |
| `npm run package:dsh-runtime` | 打包 dsh 运行时(输出 `dsh-runtime/`) |
| `npm run provision:dsh` | 把 StarHub 组合装进一个 dsh profile |
| `npm run version` | 版本号同步(四处) |

上游 Electron 壳打包(发布链):

```bash
pnpm --dir vendor/deepseek-harness/apps/desktop run package:win:x64:unsigned
```

## 文档

- [docs/技术方案.md](./docs/技术方案.md) — 完整技术方案与功能矩阵
- [docs/设计系统.md](./docs/设计系统.md) — UI token 与组件规范
- [docs/踩坑记录.md](./docs/踩坑记录.md) + [docs/已知坑索引.md](./docs/已知坑索引.md) — 已知坑
- [CHANGELOG.md](./CHANGELOG.md) — 版本演进
- [AGENTS.md](./AGENTS.md) — AI Agent / 贡献者协作指引(目录结构、命令、提交与发版约定)

## 安全

- 密码、私钥、API Key 存 sidecar 的密钥存储(文件或内存;系统 Keyring 迁移见技术方案 §六)
- AI 执行写操作(SSH 写、SQL 写、文件删除、传输等)一律弹确认卡,超时按拒绝处理
- hostkey 自动接受不持久化,MFA 验证码不回写
- 直播/接管的帧通道只绑 127.0.0.1,一次性令牌握手后即弃

## 关于(About)

**StarHub** — All-in-One DevOps Desktop Command Center。把开发运维每天要用到的工具收进同一个窗口:数据库客户端 · SSH 终端 · SFTP · Docker · Android 真机 · AI 助手。

**三条产品原则:**

1. **一个窗口,而不是一个启动器。** 工具切换是纯损耗。StarHub 让数据库、终端、SFTP、Docker、Android 真机共享同一套资产、同一条连接,AI 共享同一份上下文——不是把五个图标摆进一个格子。
2. **AI 是操作面,不是聊天框。** 助手通过 Function Calling 直接驱动真实资产;每一次写操作(SSH 命令、SQL、文件删除、传输)都弹确认卡,超时按拒绝处理,全程落审计日志。
3. **每一步都有据可查。** 密码与私钥只进 sidecar 密钥存储,hostkey 自动接受不持久化,直播/接管的帧通道只绑 127.0.0.1——真实设备上的每个动作都自动截屏留档、可回放。

| 项 | 值 |
|---|---|
| 当前版本 | v0.136.1 |
| 官网 | [starthub.waouzzz.cc](https://starthub.waouzzz.cc/) |
| 仓库 | [github.com/dabaicai001/starhub](https://github.com/dabaicai001/starhub) |
| 问题反馈 | [GitHub Issues](https://github.com/dabaicai001/starhub/issues) |
| 协议 | MIT · Copyright © 2026 StarHub Authors |

**致谢与依赖**:

- AI 主壳基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(插件化 agent harness,`vendor/deepseek-harness` 整树 vendored);
- Android 直播的 H.264 通道使用 [scrcpy](https://github.com/Genymobile/scrcpy) server(Apache-2.0);
- 终端 [xterm.js](https://xtermjs.org/),数据库/中间件适配由内置 Go sidecar 承载。

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
