/**
 * Browser StarHub navigation plugin(方案 P1,重构版):侧栏「工具」主面板行
 * (sidebar.panellist + main v0.123.2;此前为 footer.action + shell.overlay
 * 浮层)+ shell.overlay(连接对话框 / 连接卡)+ dsh 设置面板的
 * StarHub 分区。
 *
 * 状态拆分:nav store(root scope,仅大类展开态)挂在 sidebar.navigation
 * 上;资产列表、「当前子类 + 当前资产」与连接对话框开关由
 * apply 持有的三份裸 source 承载,经各注册的 inject hooks 舱位下发、经
 * 注入回调写入——one-handle-one-scope 约束(共享 handle 跨 scope 挂载抛错)
 * 与 session-maybe 无会话分支不下发注册侧 store 这两条规定,把共享状态都
 * 推到了 hooks 舱位范式(同 ui-agent-preset controller)。
 *
 * 资产操作页优先在当前会话的 DSH 右侧栏开/聚焦原生标签,由同源 iframe
 * 承载 `/starhub-react/`。没有会话或右侧栏服务时使用独立工作台主面板。
 * 选择桥记录当前资产,供 AI 工具上下文同步使用。
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the SlotMap rows of the target slots must be in the program for
// the register calls to type (declared by the slots' owning packages).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: connection service merge 不再使用(0.1.6 起 connection.api 撤除,
// Host RPC 走 ctx.remote);保留 dsh-client-connection 仅因 SessionId 经垫片转口。
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only:0.1.7 会话选择经 uiWorkspace.openSession 导航;ui-session 的
// SessionReferenceSourceMap 合并提供 mainView 键(currentSessionId 读取前提)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only:把 settings controller 的 remote 面(`settings.describe/mutate/...`)
// 并进 `TypertClientRemote` 的声明合并;`inject` 里已声明 `remote.settings`,
// 这里只补类型。
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import { currentSessionId } from './current-session.ts'
import { createStarHubAssetSource, DOCKER_REFERENCE_TAG, STARHUB_ASSET_SOURCE } from './asset-source.ts'
import { createAskAiHandler, createOpenAssetHandler, subscribeHostEvents } from './host-events.ts'
import {
  createConnectionManagerOverlay, createStarHubAssets, createToolSelectionBridge, loadStarHubAsset,
  type RustAsset,
} from './store.ts'
import { createExecRecordsBridge, subscribeSshExecEvents } from './conn/exec-records.ts'
import { assetSubtitle, assetWindowUrl, routePrefixForAsset, STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'
import { interactionMessages } from './interaction-messages.ts'
import { bindAssetContext } from './tool-context.ts'
import { focusWindowByKey, installWorkbenchPageHost, openNewPage, tauriInvoke } from './tauri.ts'
import { StarHubOverlay, type StarHubOverlayInjected } from './StarHubOverlay.tsx'
import { ToolsPanelIcon } from './ToolsPanelIcon.tsx'
import { StarHubToolWorkspace, type StarHubToolWorkspaceInjected } from './StarHubToolWorkspace.tsx'
import { StarHubWorkbenchPanel, type StarHubWorkbenchPanelInjected, type TerminalFrameTracker, type TerminalReference, type WorkbenchReference } from './StarHubWorkbenchPanel.tsx'
import { installSidebarTools } from './sidebar-tools.tsx'
import { installSidebarWorkbench } from './sidebar-workbench.tsx'
import { createWorkbenchPanelStore, embeddedWorkbenchUrl, type WorkbenchPage } from './workbench-panel.ts'
import {
  createLivePanelStore,
  installLivePanelHost,
  type LiveChannel,
} from './live/live-panel.ts'
import { StarHubLivePanel, type StarHubLivePanelInjected } from './live/StarHubLivePanel.tsx'
import { AndroidSettingsTab } from './settings/android.tsx'
import { workbenchQuoteTarget } from './workbench-reference.ts'
import { connectedTerminalInFrame } from './terminal/reference.ts'

/**
 * Required services: the slot registry, the connection wire, the input-trigger
 * pipeline (for the `@` source), the session/workspace/conversation services
 * (for `starhub://ask-ai`), and the typed Remote namespace this plugin writes:
 * `remote.settings` (tool-context). Since the 0.1.6 Typert gateway each
 * Remote namespace is its own `remote.<ns>` service, and `ctx.remote.<ns>`
 * throws `cannot get property "remote.<ns>" without inject` unless the
 * owning fiber declares the dotted name (v0.121.7 启动事故)。
 */
export const inject = ['slots', 'connection', 'remote', 'remote.settings', 'layout', 'inputTriggers', 'sessions', 'workspaces', 'conversation', 'uiWorkspace']

/**
 * 工具主面板的 panellist id / main keyed-slot key(v0.123.2 起):契约要求
 * panellist 行的 id 必须在 layout 的 root-scope `main` keyed 槽有同名注册,
 * 否则 layout.selectPanel 抛错(与 ui-plugin-manager 的 PANEL_ID 同机制)。
 */
const TOOLS_PANEL_ID = 'starhub-tools' as MainPanelId

/** 工作台主面板 id(去 Tauri 化 M2 第 6 步:资产实例操作页的壳内座位)。 */
const WORKBENCH_PANEL_ID = 'starhub-workbench' as MainPanelId

/** 直播/接管主面板 id(去 Tauri 化 M3:Android 直播面板的壳内座位)。 */
const LIVE_PANEL_ID = 'starhub-live' as MainPanelId

/**
 * Client plugin body: one root-scope store handle (sidebar) plus the
 * apply-owned selection bridge, asset-list holder, and connection-dialog
 * holder across the registrations — the sidebar navigation, the overlay
 * dialog layer, the two tool-workspace column seats (`workspace` for the
 * no-session state, `details.workspace` inside the session details
 * panel), and the dsh settings dialog's StarHub section. All ride
 * slots.inject, so each waits on its slot declaration and plugin unload
 * removes the contribution.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const assets = createStarHubAssets()
  const selection = createToolSelectionBridge()
  const connectionManager = createConnectionManagerOverlay()
  // ssh:exec-done 按当时活跃的会话归档,从工具面板查看。
  const execRecords = createExecRecordsBridge()
  // ssh:exec-done 通用事件订阅:插件生命周期常驻(ctx.effect 卸载时反注册),
  // 不随头部按钮/工具抽屉的开合与重挂载丢失;dsh: 以外的会话由 note 忽略。
  ctx.effect(
    () => subscribeSshExecEvents(execRecords.note),
    'starhub: ssh exec-done events',
  )
  // 服务面:注入数组已声明依赖,读取必然非空;conversation 在预填时退化处理。
  // 0.1.6:apiproxy 的 connection.api 撤除,类型化 Host RPC 走 ctx.remote
  // (api-gateway 的 ClientRemote);settings 写入统一经 remote.settings。
  const settingsWriter = ctx.remote.settings
  const layout = ctx.get('layout') as ILayout
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // inject 声明了 required 'conversation',加载后必然存在(cordis ctx.get 返回可空)。
  const conversation = ctx.get('conversation') as unknown as ConversationController
  // 执行记录按会话隔离(2026-08-27):把「当前活跃会话」喂给 execRecords 桥,
  // 列表与「清空」都只作用于本会话;
  // 首次同步立即写一次(不依赖切换事件才初始化)。
  ctx.effect(() => {
    const sync = () => { execRecords.setConversation(currentSessionId(sessions.list.getSnapshot())) }
    sync()
    return sessions.list.subscribe(sync)
  }, 'starhub: exec records follow current session')
  // StarHub 工作台遵循 dsh 设计理念:不再注入自有主题 token(旧 --dsw-accent /
  // --dsw-font-mono / --dsw-shadow-popover 等历史令牌),统一消费 ui-theme 的
  // --dsw-alias-* 语义别名,深浅色由 dsh 主题所有者(ui-theme)处理。
  // 工作台 iframe 不跑 ui-theme 插件树:打开时用 `dark` 参数落一次主题,之后
  // 用户在 DSH 里切深浅色时经同源 BroadcastChannel 广播,已打开的页实时跟随。
  ctx.effect(() => {
    if (typeof BroadcastChannel === 'undefined') return () => {}
    const channel = new BroadcastChannel('starhub-theme')
    const publish = (): void => {
      channel.postMessage({ dark: document.body.hasAttribute('data-ds-dark-theme') })
    }
    const observer = new MutationObserver(publish)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      observer.disconnect()
      channel.close()
    }
  }, 'starhub: workbench theme broadcast')
  const getCurrentSession = () => currentSessionId(sessions.list.getSnapshot())
  const insertAssetReference = (
    asset: RustAsset,
    sessionId = getCurrentSession(),
    terminalSessionId?: string,
  ): void | Promise<void> => {
    const session = sessionId === undefined ? undefined : sessions.binding(sessionId)
    if (sessionId === undefined || session === undefined) {
      if (terminalSessionId !== undefined) throw new Error(interactionMessages().noReferenceConversation)
      return
    }
    const input = conversation.input.for(session.ctx)
    const subcategory = STARHUB_SUBCATEGORIES.find(item => item.matches(asset))?.key ?? null
    const binding = bindAssetContext(settingsWriter, {
      subcategory, routePrefix: routePrefixForAsset(asset) ?? null,
    }, asset, sessionId, terminalSessionId)
    const insert = (): void => {
      const sub = assetSubtitle(asset)
      const dockerMark = asset.type === 'docker' ? ` ${DOCKER_REFERENCE_TAG}` : ''
      const label = `${sub === '' ? asset.name : `${asset.name} (${sub})`}${dockerMark}`
      const snapshot = input.state.getSnapshot()
      const inserted = input.insertReference(
        { source: STARHUB_ASSET_SOURCE, ref: asset.id, label, clipboardText: `@${asset.name}` },
        { start: snapshot.draft.length, end: snapshot.draft.length, draftRev: snapshot.draftRev },
      )
      if (!inserted) input.setDraft(`${snapshot.draft}@${label} `)
    }
    if (terminalSessionId === undefined) {
      insert()
      return
    }
    return binding.then(ok => {
      if (!ok) throw new Error(interactionMessages().terminalReferenceUnavailable)
      insert()
    })
  }
  const referenceTerminal: TerminalReference = async (assetId, terminalSessionId, sessionId = getCurrentSession()) => {
    const messages = interactionMessages()
    if (sessionId === undefined) throw new Error(messages.noReferenceConversation)
    const asset = assets.source.getSnapshot().assets.find(item => item.id === assetId)
      ?? await loadStarHubAsset(assetId)
    if (asset?.type !== 'ssh') throw new Error(messages.terminalReferenceUnavailable)
    await insertAssetReference(asset, sessionId, terminalSessionId)
  }
  const referenceQuote: WorkbenchReference = async (assetId, quote, sessionId = getCurrentSession()) => {
    const messages = interactionMessages()
    const session = sessionId === undefined ? undefined : sessions.binding(sessionId)
    if (sessionId === undefined || session === undefined) throw new Error(messages.noReferenceConversation)

    const asset = assets.source.getSnapshot().assets.find(item => item.id === assetId) ?? await loadStarHubAsset(assetId)
    const terminalId = quote.kind === 'ssh' ? quote.terminalSessionId : undefined
    if (asset === undefined || (quote.kind === 'ssh'
      ? asset.type !== 'ssh' || !quote.terminalSessionId.startsWith(`${assetId}__`)
      : asset.type !== 'db')) throw new Error(messages.quoteTargetUnavailable)

    const input = conversation.input.for(session.ctx)
    if (input.state.getSnapshot().phase !== 'plain') throw new Error(messages.quoteDraftUnavailable)
    const subcategory = STARHUB_SUBCATEGORIES.find(item => item.matches(asset))?.key ?? null
    const bound = await bindAssetContext(settingsWriter, {
      subcategory, routePrefix: routePrefixForAsset(asset) ?? null,
    }, asset, sessionId, terminalId, quote.kind === 'database' ? { database: quote.database } : {})
    if (!bound) throw new Error(messages.quoteTargetUnavailable)

    const endpoint = assetSubtitle(asset)
    const title = endpoint === '' ? asset.name : `${asset.name} (${endpoint})`
    const target = workbenchQuoteTarget(quote)
    const detail = [title, target].filter(Boolean).join(' · ')
    const text = quote.text.trim() === '' ? detail : `${detail}\n\n${quote.text}`
    if (!input.insertQuote(text, { label: asset.name, title, detail: target, body: quote.text || target })) {
      throw new Error(messages.quoteDraftUnavailable)
    }
    input.notify('info', messages.quoteAdded)
  }
  // Active frames are ordered by their last activation. Keep a hidden frame
  // eligible when the connection list covers the workbench.
  const terminalFrames = new Map<HTMLIFrameElement, { assetId: string; sessionId?: string }>()
  const trackTerminalFrame: TerminalFrameTracker = (frame, assetId, sessionId) => ({
    activate: () => {
      terminalFrames.delete(frame)
      terminalFrames.set(frame, { assetId, ...(sessionId === undefined ? {} : { sessionId }) })
    },
    dispose: () => { terminalFrames.delete(frame) },
  })
  const referenceFromTools = (asset: RustAsset): void | Promise<void> => {
    const sessionId = getCurrentSession()
    const messages = interactionMessages()
    if (sessionId === undefined || sessions.binding(sessionId) === undefined) throw new Error(messages.noReferenceConversation)
    if (asset.type === 'ssh') {
      const target = Array.from(terminalFrames.entries()).reverse().find(([, tab]) =>
        tab.assetId === asset.id && (tab.sessionId === undefined || tab.sessionId === sessionId))
      if (target !== undefined) {
        const terminal = connectedTerminalInFrame(target[0], asset.id)
        if (terminal === undefined) throw new Error(messages.referenceConnectedTerminal)
        return insertAssetReference(asset, sessionId, terminal)
      }
    }
    return insertAssetReference(asset, sessionId)
  }
  const openSidebarWorkbench = installSidebarWorkbench(ctx, assets, layout, sessions, referenceTerminal, trackTerminalFrame, referenceQuote)
  /** 壳内工作台页簿 + 面板切换:开/聚焦一页并把主面板切到工作台。 */
  const workbench = createWorkbenchPanelStore()
  let nextWorkbenchTab = 0
  /** Open or reveal the asset's workbench and update the AI tool selection. */
  const openAssetPage = async (asset: StarHubAsset, newTab = false): Promise<void> => {
    if (!openSidebarWorkbench(asset.id, newTab ? 'new-tab' : 'reveal')) {
      const key = newTab ? `starhub-tab:${++nextWorkbenchTab}` : workbench.findPageForAsset(asset.id)?.key ?? asset.id
      await openNewPage(embeddedWorkbenchUrl(assetWindowUrl(asset)), asset.name, key)
    }
    selection.openAsset(asset)
  }
  const openWorkbenchPage = (page: WorkbenchPage): void => {
    layout.selectPanel(WORKBENCH_PANEL_ID)
    workbench.open(page)
  }
  // openNewPage 的壳内宿主:装了宿主就不再用 window.open 开新标签页。
  // ctx.effect 保证 HMR 卸载时摘除(回到 window.open 的老行为)。
  ctx.effect(() => {
    installWorkbenchPageHost((path, title, key) => {
      openWorkbenchPage({ key: key === '' ? path : key, title: title === '' ? path : title, url: path })
    })
    return () => { installWorkbenchPageHost(null) }
  }, 'starhub: workbench page host')
  // 页簿空 → 面板让回**会话视图**(v0.132.0:不再回退工具列表——关页即离开
  // 工具面板,与面板 × 同义;工作台/直播两个页面同一规则)。用户在这儿的动线:
  // 工具面板 → 点资产 → 工作台页 → 关页 → 回会话。store 的 subscribe 不带快照
  // 参数(框架约定),「上一态有没有页」由本地变量记住,只在「有页变无页」的沿上切,
  // 避免无谓的面板跳转。
  ctx.effect(() => {
    let hadPages = workbench.source.getSnapshot().pages.length > 0
    return workbench.source.subscribe(() => {
      const hasPages = workbench.source.getSnapshot().pages.length > 0
      if (hadPages && !hasPages) layout.selectPanel(null)
      hadPages = hasPages
    })
  }, 'starhub: workbench panel fallback')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'starhub-overlay',
    order: 100,
    label: 'StarHub',
    inject: (): StarHubOverlayInjected => ({
      openConnectionManager: () =>{  connectionManager.open() },
      closeConnectionManager: connectionManager.close,
      onConnectionSaved: (change) => {
        assets.applyChange(change)
        if (change.kind === 'created') {
          const category = STARHUB_SUBCATEGORIES.find(item => item.matches(change.asset))
          if (category !== undefined) selection.selectSubcategory(category.key)
        }
      },
      hooks: {
        connectionManager: connectionManager.source,
      },
    }),
  }, StarHubOverlay))
  // 沙箱桌面「请求人工介入」横幅随沙箱桌面域整体退役(v0.132.0)。
  // 主壳 AI 连接卡(StarHubConnCard)随 v0.140.0「AI 复用用户终端会话」模型
  // 一并退役:AI 不再持有连接,MFA / 堡垒机选机器 / 主机密钥提示只属于
  // 用户自己的终端页,壳内不再需要第二张验证卡。
  const workspaceInject = (): Omit<StarHubToolWorkspaceInjected, 'closeTools'> => ({
    openAsset: openAssetPage,
    refreshAssets: assets.refresh,
    openConnectionManager: connectionManager.open,
    dismissConnectionChange: assets.dismissChange,
    openExecRecords: execRecords.openView,
    clearExecRecords: execRecords.clear,
    // 行内「断开连接」(v0.100.1):先移除记录(UI 即时消失),再异步断开
    // 后端 SSH 连接;断开失败仅记日志——连接可能已自行断开,记录照样不显示。
    disconnectExecSession: (sessionId: string) => {
      execRecords.removeSession(sessionId)
      tauriInvoke('ssh_disconnect', { id: sessionId }).catch((e: unknown) => {
        console.error('关闭 SSH 连接失败:', sessionId, e)
      })
    },
    // 选中/收起一个子类:写入选择桥(手风琴,再点当前行收起);面板据此
    // 展开该子类的资产列表或收起。
    selectSubcategory: (key: string | null) => { selection.selectSubcategory(key) },
    insertAssetReference: referenceFromTools,
    hooks: {
      selection: selection.source,
      assets: assets.source,
      execRecords: execRecords.source,
    },
  })
  // 工具面板(v0.123.2):从侧栏底部 footer.action + shell.overlay 浮层迁到
  // **主面板**——sidebar.panellist 行(order 1,紧随「插件」order 0 之下;
  // 侧栏拥有按钮/标签/选中态,本行只出图标)+ main keyed 槽承载面板本体。
  // 标签带品牌名(v0.133.0):侧栏里「工具」太泛,与「插件」「自动化任务」并列
  // 时分不清是谁的工具;图标同步换成 StarHub 品牌字形(四角星 + 中心节点)。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: TOOLS_PANEL_ID,
    order: 1,
    label: 'StarHub 工具',
  }, ToolsPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: TOOLS_PANEL_ID,
    inject: () => ({
      ...workspaceInject(),
      closeTools: () => {
        execRecords.closeView()
        layout.selectPanel(null)
      },
    }),
  }, StarHubToolWorkspace))
  installSidebarTools(ctx, () => ({ ...workspaceInject(), closeExecRecords: execRecords.closeView }))
  // 独立工作台主面板供无会话或无右侧栏服务的宿主使用。
  const workbenchInject = (): StarHubWorkbenchPanelInjected => ({
    activatePage: (key) => { workbench.activateIfOpen(key) },
    closePage: (key) => { workbench.close(key) },
    // 空页簿兜底:面板被恢复成 workbench 但没有页时,给用户一个明确的出口,
    // 而不是把主区留成白板。
    closeWorkbench: () => { layout.selectPanel(null) },
    referenceTerminal,
    referenceQuote,
    trackTerminalFrame,
    hooks: { workbench: workbench.source },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKBENCH_PANEL_ID,
    inject: workbenchInject,
  }, StarHubWorkbenchPanel))
  // 直播/接管主面板(M3):keyed main 槽,不占侧栏 panellist 行(v0.130.0
  // 移除「直播」侧栏行——无通道时点开是空白页;行移除后面板只在有直播
  // 会话时自动切入,与工作台面板同先例)。帧与输入走宿主 upgrade 路由
  // `/starhub/live`(bridge 中继到 sidecar 的本地 WS),通道簿空时组件渲染
  // null。入口是 Android 子类的「直播」按钮与模型面 `android_ui_open_live`
  // 的 UI 意图;簿空 → 面板让回会话视图(下方订阅)。
  const live = createLivePanelStore()
  const openLiveChannel = (channel: LiveChannel): void => {
    live.open(channel)
    layout.selectPanel(LIVE_PANEL_ID)
  }
  ctx.effect(() => {
    installLivePanelHost(openLiveChannel)
    return () => { installLivePanelHost(null) }
  }, 'starhub: live panel host')
  ctx.effect(() => {
    let hadChannels = live.source.getSnapshot().channels.length > 0
    return live.source.subscribe(() => {
      const hasChannels = live.source.getSnapshot().channels.length > 0
      if (hadChannels && !hasChannels) layout.selectPanel(null)
      hadChannels = hasChannels
    })
  }, 'starhub: live panel fallback')
  const liveInject = (): StarHubLivePanelInjected => ({
    activateChannel: (channel) => { live.activate(channel) },
    closeChannel: (channel) => { live.close(channel) },
    setStatus: live.setStatus,
    setMeta: live.setMeta,
    setTakeover: live.setTakeover,
    hooks: { live: live.source },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: LIVE_PANEL_ID,
    inject: liveInject,
  }, StarHubLivePanel))
  // 契约 §6.1:`@` 资产 source(ui-input-trigger 流水线);pick 轻绑定上下文,
  // 不切窗口。ctx.effect 保证 HMR 卸载时反注册 source。
  ctx.effect(
    () => inputTriggers.registerSource(createStarHubAssetSource({ writer: settingsWriter, assets, selection })),
    'starhub: @ asset source',
  )
  // 契约 §6.2-6.3:监听 Tauri 宿主事件(open-asset / ask-ai);订阅经
  // ctx.effect 注册,dispose 卸载监听(HMR 安全)。
  ctx.effect(() => subscribeHostEvents({
    onOpenAsset: createOpenAssetHandler({
      assets,
      openAssetPage: (asset) => {
        void openAssetPage(asset).catch((error: unknown) => { console.error('打开资产页面失败:', error) })
      },
      focusWindow: async (key) => {
        if (openSidebarWorkbench(key, 'if-open')) return true
        const page = workbench.findPageForAsset(key)
        if (page !== undefined && workbench.activateIfOpen(page.key)) {
          layout.selectPanel(WORKBENCH_PANEL_ID)
          return true
        }
        return focusWindowByKey(key)
      },
    }),
    onAskAi: createAskAiHandler({
      writer: settingsWriter,
      selection,
      sessions,
      workspaces,
      uiWorkspace: ctx.get('uiWorkspace') as UiWorkspace,
      conversation,
    }),
  }), 'starhub: tauri host events')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'starhub-android',
    order: 30,
    label: interactionMessages().androidDevices,
  }, AndroidSettingsTab))
}
