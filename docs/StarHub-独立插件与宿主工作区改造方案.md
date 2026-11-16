# StarHub 独立插件与宿主工作区改造方案

- 日期：2026-11-16
- 状态：待评审，尚未实施
- 目标宿主：官方 DeepSeek Harness `0.2.2-rc.3`
- 后续执行模型：按用户要求使用 `6.1-sol`

## 1. 结论与范围

StarHub 应独立维护插件、Rust/Go sidecar 和前端资产，逐步解除对 `vendor/deepseek-harness` 源码树的编译、测试和发布依赖。完成替代构建与验收后，删除 vendored 上游源码。

体验改造优先使用宿主已有的资源标签、分屏、全屏及壳内浮动面板。独立操作系统窗口不作为本轮目标。

本次仅提交方案，不迁移源码、不删除 vendor、不修改发布流程、不发布版本。此文档描述目标状态，不表示当前架构已改变。实际架构仍以现有代码与去 Tauri 化 M1–M4 文档为准；`技术方案.md` 中保留的早期 Tauri/Vue 规划不能作为新实现依据。

## 2. 已确认事实与证据边界

| 项目 | 结论 |
|---|---|
| 官方版本 | 调研时最新发布版为 `0.2.2-rc.3`，2026-11-13 发布，属于预发布版本 |
| StarHub 安装 | 用户已确认在该版本正常安装；不再把安装可行性当成未解决问题 |
| 功能兼容 | 本轮未实测 SSH、数据库、AI、更新等完整链路；正常安装不等于完整验收 |
| 原生多窗口 | 官方主窗口代码拦截 `window.open()`，HTTP/HTTPS 转系统浏览器；再次启动聚焦主窗口，公开桌面接口未提供插件建窗能力 |
| 壳内工作区 | 有资源标签、浮动、停靠和全屏能力；按 DSH 会话组织，停靠区当前最多两个横向面板 |
| 全局页面 | 可注册 `main` keyed slot，使用 `ctx.layout.selectPanel()` 选择页面 |
| 现有构建 | 根脚本、插件打包、测试和 release workflow 仍引用 vendored；StarHub 自有源码也位于其中 |

官方版本固定链接见文末。窗口判断基于该发布标签的源码，不以本地旧 vendored 版本推断新版能力。

### 已有能力必须保留

当前 CHANGELOG 已记录以下修复，后续应复用和验证，不能按“尚未实现”重做：

- v0.141.3：AI 上下文按会话保存、目标条与终端选区附带。
- v0.141.4：工作台请求预算、执行中止和 live-context 快照缓存/冷却。
- v0.141.5：同资产多 SSH 连接的最近连接选择策略；明确页面绑定仍优先。
- v0.141.6：Host/Client 两个 TypeScript 聚合面的构建修复。

## 3. 目标交付与目录

用户安装官方 DSH，再安装 StarHub bundle。官方负责 Electron 壳、宿主运行时、签名及桌面更新；StarHub 负责自己的插件更新和 sidecar 产物。

```text
starhub/
├── packages/starhub/          # 从 vendored 迁出的现有插件，先保持包名与职责
├── apps/starhub-workbench/    # 从 apps/starhub-window 迁出，过渡期保留独立资产入口
├── sidecar-rust/
├── sidecar/
├── scripts/                  # 只构建、测试和组装 StarHub
├── tests/                    # 独立插件单测与官方宿主集成验收
├── docs/
├── pnpm-workspace.yaml       # StarHub 自己的工作区
└── dist-plugin/              # 插件、静态资源、对应平台 sidecar
```

该目录是迁移建议。优先保持现有插件包名、bundle 名、profile entry id、数据路径和资源身份稳定；目录迁移不顺便重命名产品契约。

### 依赖与发布原则

1. 编译使用已发布的 DSH 包，首轮锁定 `0.2.2-rc.3` 对应版本和 lockfile；先核实实际包版本、导出及类型文件，不能假设所有源码路径都有公开包。
2. 区分开发依赖、宿主提供的运行时模块和需随插件携带的第三方依赖。不能简单将现有 workspace 依赖全部改成 bundle runtime dependencies。
3. 保持宿主与插件使用同一份 Cordis/React 等共享模块身份，按官方 client module 机制声明外部模块，避免打包第二套宿主服务。
4. 当前 bundle 有零 dependencies/peerDependencies 校验及 client module id 重写逻辑。先审查其在新版的必要性，再调整；不能机械添加 peers 或直接移除这些逻辑。
5. `engines.dsh` 只声明实际验证过的范围。预发布版本范围须显式验证 semver 行为，不凭普通稳定版范围推断兼容。
6. 保留平台/架构声明、sidecar 定位与退出清理。未验证的平台不扩大发布支持范围。
7. 测试可安装官方精确版本运行时；不再要求维护完整上游源码或自行构建 Electron。

## 4. 交互与状态设计

### 4.1 资产中心与排障会话

- 资产中心作为全局页面：管理连接、分组、收藏和最近使用，不要求先创建 AI 会话。
- 需要 AI 排障时，用户选择现有会话或进入新的排障会话，再打开对应资源。
- 不为每次单击资产静默创建一个 AI 会话。保留直接使用工具的入口；过渡期可继续由独立工作台承担。
- 全局页面与会话右侧工作区的生命周期不同。打开资源前完成会话选择和工作区挂载，不能在全局页直接假设 `sidebarRight` 可用。

### 4.2 接入宿主资源标签

通过 `ctx.sidebarRightTabs.register(...)` 注册资源类型，通过 `ctx.slots.register(...)` 注册 `sidebar.right.pane.tab` 内容，由 `ctx.sidebarRight.openResource(...)` 导航。资源地址使用插件定义的 `dsh-resource://` 类型，具体类型名在实现时补齐声明与解析测试。

优先交付 SSH，稳定后迁移数据库、Docker，再处理 Android/浏览器等特殊能力。使用 `destination: 'float'` 提供壳内浮动；普通/全屏/停靠由宿主接口管理。不直接依赖标注为内部引擎的 dockkit 布局快照和操作日志。

逐步将资源内容直接挂为 React 组件，减少整页 iframe；不能在移除 iframe 前遗漏主题、语言、快捷键、通信和原页面关闭语义。现有 `starhub-window` 资产入口是否最终退役，待所有消费者迁移后决定。

### 4.3 身份和资源生命周期

| 标识 | 用途 |
|---|---|
| assetId | 保存的连接配置 |
| resource/content identity | 宿主资源去重与恢复；同资产多个终端/查询页需区分实例 |
| terminalSessionId / connectionId | sidecar 中实际连接或终端实例 |
| DSH sessionId | AI 会话与工作区范围 |
| tabId | 宿主标签实例；不得拿它替代资产或连接标识 |

连接由 Host/sidecar 持有，UI 只拥有订阅和视图状态。切换标签、隐藏页面、浮动/停靠及进入全屏不能重复建连或断开连接。关闭标签、显式断开、关闭会话、卸载插件分别定义清理规则，不把全部行为绑定到 React unmount。

宿主保存布局不等于保存连接。重启后根据资源身份重新获取状态，区分仍可复用、需重连、资产已删除和加载失败。终端滚动缓存、SQL 草稿等由资源 provider 明确负责。

### 4.4 AI、性能与恢复

- 复用现有会话绑定，优先明确的终端连接；多终端时不依赖“最近连接”作为唯一判断。
- 用户发送时捕获目标、目录、SQL/选区等上下文，显示可检查的附带信息；发出后切换标签不能改变该次请求的目标。
- 模型可见的上下文应进入相应会话记录，避免恢复后无法解释之前执行的目标。
- 尽量复用宿主会话、审批、停止和消息展示；现有 SSH 助手保留到替代链路具备同等能力，不直接删除。
- 使用标签可见性暂停隐藏页面的监控轮询，保持底层连接与必要事件订阅；按需挂载内容，避免无差别 `keepMounted`。
- 保留现有超时、取消与快照缓存；重试必须重新执行失败步骤。写操作遇到连接中断时先核对执行状态，不自动重放。

## 5. 分阶段实施

| 阶段 | 工作内容 | 完成门槛 |
|---|---|---|
| P0 依赖盘点 | 列出全部 vendor 引用、私有导入、上游补丁、构建生成器及数据契约；核对 npm 包可用性 | 每项有迁出、替代、删除或暂缓结论 |
| P1 独立构建 | 迁出 StarHub 源码及配置；建立自有 workspace、Host/Client 编译面、测试和静态资源构建 | 干净 checkout 能从 lockfile 构建插件，不读取 vendor |
| P2 发布解耦 | 更新 bundle、smoke、根脚本与 CI；用官方精确版本运行时集成测试；退役自建壳产物 | 插件包在官方宿主安装、启用、重启恢复及更新路径通过 |
| P3 删除 vendor | 检查已迁出文件与补丁清单，确认工作树状态和删除绝对路径，再删除上游副本 | vendor 不存在时全链路可构建；活动代码/CI 无 vendor 依赖 |
| P4 SSH 工作区 | 接入宿主资源类型、标签、浮动/停靠、会话绑定和生命周期 | 多终端目标正确，移动不重连，停止/审批/恢复可用 |
| P5 其余工作台 | 分别迁移数据库、Docker及其他资源，处理隐藏刷新和加载错误 | 各模块专项验收通过；无消费者后才退役旧入口 |

P1–P3 先保持现有交互。P4–P5 再改体验，避免把依赖升级、源码迁移和交互重写揉成一个难以回退的改动。

若某个必要生成器或公开包缺失，记录精确阻塞项，寻找已发布入口或向上游提出扩展需求；不得为按时删除 vendor 而复制一份未受控的内核到其他目录。

## 6. 验收清单

### 独立构建与分发

- [ ] 干净 checkout、锁文件安装、Host/Client 两个聚合面编译通过；迁移前保持现有两个 tsc 门，迁移后提供等价检查。
- [ ] 插件包含所有需要的静态资源和当前发布平台 sidecar；运行不依赖开发目录。
- [ ] 根 tests、test-sftp、插件测试、构建工具和 CI 不再隐式读取 vendor。
- [ ] 官方 `0.2.2-rc.3` 的独立测试 profile 完成安装、启用、重启、禁用/重新启用与卸载清理；不操作用户日常 profile。
- [ ] 核对现有安装到新包的升级，资产、密钥引用、会话和插件配置仍可读取。
- [ ] 在测试 registry 或等价受控环境验证发布更新路径；本地 tarball 安装不能代替 npm 原地更新验收。
- [ ] 在目标 Windows 环境验证 sidecar 启动、错误报告与退出，不残留子进程。

### 功能与交互

- [ ] SSH：同资产多个终端、切换会话、浮动/停靠、全屏、关闭与重连。
- [ ] SFTP：列表、传输进度、取消与错误恢复；标签移动不中断仍应继续的传输。
- [ ] 数据库：连接、查询、取消与草稿恢复；只读探针可重复执行。
- [ ] Docker：列表、日志和状态刷新；写操作在测试资源上验收。
- [ ] Android/浏览器：若当前发布包含入口，验证其桥接和直播/接管能力未因迁移丢失。
- [ ] AI：目标显示、选区/SQL上下文、同资产多终端准确执行、审批、停止、失败重试与会话恢复。
- [ ] 隐藏标签的监控请求下降，重新显示能恢复最新状态；记录迁移前后同一场景的请求数、首屏及首次操作耗时，不预设无依据的性能提升比例。

按阶段运行相关测试与现有桥兼容/AI cancel 验收，不默认跑完整上游测试。行为变更优先补真实生命周期回归；纯路径迁移以编译、既有测试和打包冒烟为主。

## 7. 回退、提交和文档纪律

- 各阶段独立提交，删除 vendor 单独提交，留存可定位的迁移前提交。源码恢复使用 Git 历史，不保留第二份上游目录。
- 首轮不改变用户数据格式；若后续必须改，单列迁移、备份及向后读取策略。回退代码不代表旧版本能读新格式。
- npm 插件管理器的更新操作不支持任意降级，不能承诺一键回退。发布前记录经过验证的旧包重装步骤及数据恢复条件。
- 实施代码/构建变更时按仓库规则升版、更新 CHANGELOG、审查自己的改动后 commit + push；本次纯方案不升版、不打 tag。
- 每阶段同步实际状态到 `docs/技术方案.md`、`docs/架构图.html`、`CHANGELOG.md`、`AGENTS.md`；不提前把目标架构写成已完成。
- 架构决策在实施前通过 Issue 留档讨论，引用本方案；当前文档不代替已批准的实施决策。
- 保留用户已有未提交文件，不将其纳入迁移提交。

## 8. 给 6.1-sol 的执行说明

收到实施授权后，从 P0 开始，先读根 AGENTS.md 和各修改目录适用指引。本方案不是一次性重写授权；每阶段满足门槛后再推进，不绕过检查直接删除 vendor。正常安装已由用户确认，重点验证“新的独立构建产物”和“交互改造后的完整链路”。

每阶段报告：改了什么、运行了哪些检查、仍有哪些未验证项、commit/push 结果。失败时给出具体阻塞，不将未运行的测试写成通过。优先串行完成一个阶段，避免为消耗额度开多个重复审查代理。

## 9. 官方参考

以下链接固定在调研的发布标签，实施时先按该版本落地；升级到其他版本需重新核对接口。

- [0.2.2-rc.3 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)
- [桌面主窗口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/apps/desktop/src/main.ts)
- [单实例行为](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/apps/desktop/src/single-instance.ts)
- [全局布局和 main 槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/client/ui-layout/README.md)
- [资源标签、会话范围和浮动接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/client/ui-sidebar-right/README.md)
- [dockkit 内部引擎边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/client/ui-dockkit/README.md)
- [Web Client 架构与通信](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/docs/subsystems/web-client.md)
- [插件安装、兼容检查与更新](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/boot/plugin-manager/README.md)
