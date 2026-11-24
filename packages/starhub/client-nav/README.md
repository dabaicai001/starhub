# @deepseek-ai/dsh-starhub-client-nav

StarHub 浏览器导航插件(方案 P1,重构版):把 StarHub 工作台挂进 dsh web 壳的侧栏、右侧工具工作区列与设置面板。

## 行为

- **工具主面板**（`sidebar.panellist` + `main`）默认显示全部连接，支持按分类筛选，或按名称、主机、类型搜索。每行提供编辑和更多操作。更多操作与右键菜单都可打开外部浏览器或引用到当前对话。
- **Overlay**(`shell.overlay` 一次):连接对话框(工具抽屉 v0.123.2 起改主面板,见上;v0.132.0 起沙箱「请求人工介入」横幅随域移除;v0.140.0 起 MFA 验证卡 / 堡垒机选机器卡退场——AI 不再自建连接,验证提示只属于用户自己的终端页)。
- **资产操作页**（`sidebar.right.pane.tab`）在当前 DSH 会话的右侧栏打开同源 `/starhub-react/` iframe，同一会话重复打开同一资产时聚焦原有标签。没有会话或宿主未提供右侧栏服务时，使用独立工作台主面板（`main:starhub-workbench`）。
- **直播/接管主面板**(去 Tauri 化 M3 起):直播/接管线从独立直播窗口(`android-live://` custom protocol + 自包含页)改为壳内**直播主面板**(第三个 keyed `main` 槽 key=`starhub-live`)。一通道一页;帧与输入走宿主 upgrade 路由 `/starhub/live`(由 `starhub-bridge` 中继到 sidecar 的本地 WS),PNG 帧直画 canvas、H.264 帧经 WebCodecs 解码(annexb → avcC 描述集);接管开关经 `{"t":"takeover"}` 写帧枢纽,与 AI 写操作互斥;指针/滚轮经 `{"t":"input"}` 下行,坐标按 contain 内容矩形映射回设备物理像素。通道簿空时组件渲染 null 且面板让回会话视图(v0.132.0 起)。v0.130.0 起侧栏「直播」行移除:该面板只在 AI/Android 面板触发真实直播会话时自动出现,手动点入只会看到空画面。
- **SSH 对话引用**。在已连接的 SSH 终端点击页头「引用到对话」或使用右键菜单，将该页 SSH 会话 id 绑定到当前 DSH 会话并插入草稿引用。对话中的 SSH/SFTP 工具复用该页连接。
- **设置分区**(`settings.section` ×2,v0.130.0 起):Android 设备、SSH。审计日志、告警规则、沙箱平台、AI 浏览器、关于五个区块 v0.130.0 一并移除。(更早:v0.123.1 起「插件市场」与「AI 助手」区块移除:前者由壳内首页「插件」面板接管,后者(长期记忆)整条栈退场。)
- **SFTP 传输中心**(v0.118.0):传输任务列表从 SftpPanel 内联区块升级为 overlay 级弹框(`TransferDialog` + 会话级投影 hook `useTransferTasks`)——任务监听挂在 SSH 工作区 overlay 而非面板,关掉「文件」页签传输不丢,「文件」页签与面板工具栏显示进行中计数徽标;弹框内含任务级聚合进度条(不再用文件级数字,多文件不回跳)、当前文件名、实时速度/ETA、逐文件明细、暂停/继续/取消/重试(失败与已取消都支持,断点续传)、单条删除/清除已完成/全部暂停、失败原因完整展示+复制、运行中动态限速(KB/s)、下载完成「打开目录」(`sftp_reveal_local`)。

## Model Experience

### Browser navigation surface

#### What the model sees

Nothing directly — this package registers only browser-side UI (sidebar navigation, `shell.overlay` dialogs, `settings.section` rows). Model-visible context comes from the `starhub-tool-context` package, which injects the current tool/asset selection on every pre-step.

#### Token effect

None — pure presentation; no prompt or message contribution.

#### KV Cache effect

Not applicable — the package never participates in model requests.

## Known Limitations and Deferred Work

- 数据库/终端/SFTP 等重型工作台模块的测试覆盖率薄(terminal-cwd / xshell-quick-command / quick-commands / sftp-service 曾低至 3-44%,v0.92.2 补齐到 per-file 100%);交互路径复杂,后续仍需按模块补行为级用例。
- 浏览器预览(:3085)下无 Tauri IPC,资产/数据库等操作退化为错误提示或预览态,与桌面端行为有差异。
