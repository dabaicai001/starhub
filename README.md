<div align="center">

<img src="./docs/assets/starhub-logo.png" alt="StarHub" width="240" />

# StarHub

**All-in-One DevOps Desktop Command Center**

*数据库 · 终端 · 文件 · 容器 · 真机 · AI —— 收进同一个窗口*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.143.1-cyan)]()
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
- **前端** — DeepSeek Harness(dsh)主壳 + StarHub 的 React 工作台;StarHub 自有源码在 `packages/starhub/*`(10 个内置插件:导航、工具桥、直播、审批、领域事件等)与 `apps/starhub-workbench`(独立资产入口),经 dsh 的槽位系统接入,不改上游内核。

## 当前版本

### v0.143.1 (2026-11-23)
- 🐛 打开 StarHub 工作台、刷新连接列表及提交连接表单时显示进度。浏览器打开失败或复制失败时显示原因，资产行可直接打开宿主内工作台。
- 🐛 工作台区分加载失败和资产不存在，支持原地重试。Docker 和 Elasticsearch 连接失败后可直接重连。
- 🐛 连接测试期间禁用保存、删除与配置修改，允许关闭弹窗。保存或删除时显示对应进度，SSH 验证码提交失败时保留输入以便重试。

> 历史版本见 [CHANGELOG.md](./CHANGELOG.md)。

## 下载

[GitHub Releases](https://github.com/dabaicai001/starhub/releases) 提供 **纯插件包**:

| 平台 | 产物 |
|---|---|
| Windows x64 | `starhub-dsh-plugin-<版本>-win-x64.tgz`(含两个 sidecar 与工作台 dist) |

装法:先装官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),在它的
插件页「添加插件」里粘贴包名 `@starhub/dsh-plugin@<版本>`,或粘贴上面那个 tarball 的绝对路径 / Release URL。
DSH 0.2.2+ 对注册表安装的 bundle 支持插件页原地更新(Versions / Update),tarball 安装则是卸载重装。

> **不再提供 StarHub 品牌的 Electron 安装包(.exe)**(v0.143.0 起)。桌面壳、签名与更新栈归上游,
> StarHub 只交付「插件 + 两个 sidecar 子进程 + 静态资产」;理由与迁移过程见
> [docs/P3-删除vendor记录.md](./docs/P3-删除vendor记录.md)。
>
> **Linux / macOS 暂不发版**:包内是两个平台相关的 sidecar 二进制,等 sidecar 产物矩阵出来再扩。

## 开发

前置:Node 24.9+、Rust 1.96+、Go 1.25+、pnpm 10.15+。Windows 需要 MSVC 构建环境。

```bash
git clone https://github.com/dabaicai001/starhub.git
cd starhub
pnpm install                     # 根 workspace:StarHub 自有包 + 官方 @deepseek-ai/dsh-*

npm run build:lib && npm run build:lib:client && npm run build:window
npm run sidecar:build && npm run sidecar-rust:build
npm run plugin:bundle            # 组装 dist-plugin/
npm run smoke:plugin-bundle      # 装进一次性 profile,官方宿主跑五条断言
```

常用命令:

| 命令 | 作用 |
|---|---|
| `npm run build:lib` | Host 面:9 个 host 插件 → `lib/types/`(tsc) |
| `npm run build:lib:client` | Client 面:client-nav 的 tsc + 自包含客户端半边 |
| `npm run build:window` | 构建 React 工作台(输出 `dist-starhub-react/`) |
| `npm run sidecar:build` / `:release` | 构建 Go Sidecar |
| `npm run sidecar-rust:build` / `:test` | Rust sidecar 构建 / 测试(Windows 自动加载 MSVC) |
| `npm run test:utils` 等 | Node `node --test` 纯逻辑测试(见 `package.json`) |
| `npm run test:starhub` | StarHub 自有 vitest 套件(插件 + 工作台) |
| `npm run plugin:bundle` / `plugin:pack` / `plugin:publish` | 组装 / 打 tarball / 发注册表 |
| `npm run smoke:plugin-bundle` | 官方宿主上的五条断言冒烟 |
| `npm run verify:bridge-compat` / `verify:ai-cancel` | 真 sidecar ↔ 桥兼容 / AI 取消链路验收 |
| `npm run version` | 版本号同步(四处) |

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

- AI 主壳基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(插件化 agent harness);StarHub 以插件 bundle 形式装载,按官方已发布 npm 包编译(v0.143.0 起仓库内不再 vendored 上游源码);
- Android 直播的 H.264 通道使用 [scrcpy](https://github.com/Genymobile/scrcpy) server(Apache-2.0);
- 终端 [xterm.js](https://xtermjs.org/),数据库/中间件适配由内置 Go sidecar 承载。

## License

[MIT](./LICENSE) · Copyright © 2026 StarHub Authors
