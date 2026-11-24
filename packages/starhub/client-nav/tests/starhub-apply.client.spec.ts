// @vitest-environment jsdom
/** Client plugin wiring for navigation, dialogs, and workbench tabs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyHost } from '../src/index.ts'
import { apply as applyPlugin, inject as injectList } from '../src/client/index.ts'
import { ToolsPanelIcon } from '../src/client/ToolsPanelIcon.tsx'
import { StarHubOverlay } from '../src/client/StarHubOverlay.tsx'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { StarHubWorkbenchPanel } from '../src/client/StarHubWorkbenchPanel.tsx'
import { StarHubLivePanel } from '../src/client/live/StarHubLivePanel.tsx'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { AndroidSettingsTab } from '../src/client/settings/android.tsx'
import type { TerminalFrameTracker } from '../src/client/StarHubWorkbenchPanel.tsx'
import { STARHUB_ASSET_SOURCE } from '../src/client/asset-source.ts'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'
import { createSettingsWriter, lastBinding } from './settings-writer.ts'

afterEach(() => {
  vi.restoreAllMocks()
  restoreHostBridge()
})

/** Register-options face the client apply passes to slots.register, typed for the call log. */
interface RegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string
  /** keyed 槽(main)的 entry key;list 槽注册不带。 */
  key?: string
  store?: { create: () => unknown }
  inject: () => Record<string, unknown>
}

/** 最小 ctx 替身:slots.inject 立即触发 register,layout/get/effect 打桩。 */
function fakeContext(overrides: {
  sessions?: unknown
  conversation?: unknown
  remote?: unknown
  layout?: unknown
  sidebarRight?: unknown
} = {}) {
  const register = vi.fn((_options: RegisterOptions, _component: unknown) => () => {})
  const inject = vi.fn((_name: string, fn: () => unknown) => fn())
  const registerSource = vi.fn((_src: unknown) => () => {})
  const effects: Array<() => (() => void) | undefined> = []
  const effect = vi.fn((fn: () => unknown) => {
    const disposer = fn() as () => (() => void) | undefined
    effects.push(disposer)
    return disposer
  })
  const get = vi.fn((name: string) => {
    switch (name) {

      case 'inputTriggers':
        return { registerSource }
      case 'layout':
        return overrides.layout ?? { selectPanel: vi.fn() }
      case 'sessions':
        return overrides.sessions ?? {
          list: {
            getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
            // exec-records 会话跟踪(apply 层)订阅 list;返回 disposer,与
            // runtime/client-apply.client.spec.ts 的 sessions mock 同形态。
            subscribe: () => () => {},
          },
          binding: vi.fn(() => undefined),
        }
      case 'uiWorkspace':
        return { openSession: vi.fn() }
      case 'workspaces':
        return { list: { getSnapshot: () => ({ items: [] }) } }
      case 'conversation':
        return overrides.conversation ?? {
          createDrafts: vi.fn(() => []),
          releaseDraftAttachments: vi.fn(),
          input: { for: vi.fn(() => ({ setDraft: vi.fn(), addAttachments: vi.fn(() => true) })) },
        }
      default:
        return undefined
    }
  })
  const provided: Record<string, unknown> = {}
  const provide = vi.fn((name: string, value: unknown) => { provided[name] = value })
  const registerTabType = vi.fn((_definition: SidebarRightTabDefinition) => () => {})
  const ctx = {
    slots: { inject, register },
    inject: (_services: string[], apply: (ctx: Context) => void) => {
      if (overrides.sidebarRight !== undefined) apply(ctx)
    },
    sidebarRight: overrides.sidebarRight,
    sidebarRightTabs: { register: registerTabType },
    get,
    effect,
    provide,
    // 0.1.6:apiproxy 撤除,settings 写入与类型化 RPC 走 ctx.remote(api-gateway)。
    remote: overrides.remote ?? {
      settings: {
        update: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
        mutate: vi.fn(() => Promise.resolve({ ok: true, result: { value: {} } })),
      },
    },
  } as unknown as Context
  return { ctx, register, inject, get, registerSource, effects, provide, provided, registerTabType }
}

/** 按 main keyed 槽的 key 找注册配置(索引会随新槽插入而漂移,不写死下标)。 */
function mainByKey(register: ReturnType<typeof fakeContext>['register'], key: string): RegisterOptions {
  const call = register.mock.calls.find(
    (entry) => (entry[0] as RegisterOptions).name === 'main' && (entry[0] as RegisterOptions).key === key,
  )
  if (call === undefined) throw new Error(`no main slot registered for ${key}`)
  return call[0] as RegisterOptions
}

describe('client-nav apply (rc.2)', () => {
  it('node half apply is a no-op', () => {
    expect(() =>{  applyHost() }).not.toThrow()
  })

  it('registers the rc.2 slots with their components in order', () => {
    const { ctx, inject, register } = fakeContext()
    applyPlugin(ctx)
    // v0.140.0:主壳 AI 连接卡(StarHubConnCard)随「AI 复用用户终端会话」
    // 模型退役,shell.overlay 只剩 StarHubOverlay 一个席位。
    expect(inject.mock.calls.map(c => c[0])).toEqual([
      'shell.overlay',
      'sidebar.panellist', 'main', 'main', 'main',
      'settings.section',
    ])
    const components = register.mock.calls.map(c => c[1])
    expect(components).toEqual([
      StarHubOverlay,
      ToolsPanelIcon, StarHubToolWorkspace, StarHubWorkbenchPanel, StarHubLivePanel,
      AndroidSettingsTab,
    ])
  })

  it('live panel rides a keyed main slot with no panellist row (v0.130.0: row removed)', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    // v0.130.0:直播侧栏行移除(空壳白屏 + 无会话态);面板保留 keyed main 槽,
    // 由 Android 面板「直播」按钮 / android_ui_open_live 拉起(与工作台面板同
    // 形态:keyed main 不占侧栏行)。侧栏行只剩「工具」一条。
    const rows = register.mock.calls.filter(c => (c[0] as RegisterOptions).name === 'sidebar.panellist')
    expect(rows).toHaveLength(1)
    expect((rows[0]![0] as RegisterOptions).id).toBe('starhub-tools')
    // main keyed 槽仍在:契约要求同 id 注册,否则 layout.selectPanel 抛错。
    const mainConfig = mainByKey(register, 'starhub-live')
    expect(mainConfig.name).toBe('main')
    expect(mainConfig.key).toBe('starhub-live')
  })

  it('live panel inject exposes the channel writes the component drives', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const liveConfig = mainByKey(register, 'starhub-live')
    const injected = liveConfig.inject() as unknown as {
      activateChannel: (channel: string) => void
      closeChannel: (channel: string) => void
      setStatus: (status: string) => void
      setMeta: (meta: Record<string, unknown>) => void
      setTakeover: (takeover: boolean) => void
      hooks: { live: { getSnapshot: () => { channels: unknown[]; activeChannel: string | null } } }
    }
    expect(injected.hooks.live.getSnapshot().channels).toEqual([])
    injected.setStatus('connecting')
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ status: 'connecting' })
    injected.setMeta({ mode: 'scrcpy', width: 1080, height: 2400 })
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ mode: 'scrcpy', width: 1080 })
    injected.setTakeover(true)
    expect(injected.hooks.live.getSnapshot()).toMatchObject({ takeover: true })
  })

  it('tools entry rides the panellist row above the main panel it selects', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    // panellist 行:紧随「插件」(order 0)之下,侧栏拥有按钮/标签/选中态。
    // 按下标取会被前面的 overlay 席位增减带偏,按 id 找。
    const rowConfig = register.mock.calls
      .find(c => (c[0] as RegisterOptions).id === 'starhub-tools')![0] as RegisterOptions
    expect(rowConfig.name).toBe('sidebar.panellist')
    expect(rowConfig.id).toBe('starhub-tools')
    expect(rowConfig.order).toBe(1)
    // v0.133.0:标签带品牌名,与「插件」「自动化任务」并排时分得清是谁的工具
    expect(rowConfig.label).toBe('StarHub 工具')
    // main keyed 槽:契约要求同 id 注册,否则 layout.selectPanel 抛错。
    const mainConfig = mainByKey(register, 'starhub-tools') as RegisterOptions
    expect(mainConfig.name).toBe('main')
    expect(mainConfig.key).toBe('starhub-tools')
  })

  it('adds the toolbox to the sidebar guide and opens connections alongside the conversation', async () => {
    const selectPanel = vi.fn()
    const openResource = vi.fn()
    const { ctx, register, registerTabType } = fakeContext({
      layout: { selectPanel },
      sidebarRight: { mounted: { getSnapshot: () => 's1' }, openResource },
    })
    applyPlugin(ctx)

    const definition = registerTabType.mock.calls.find(([tab]) => tab.kind === 'starhub-toolbox')?.[0]
    expect(definition?.title('')).toBe('StarHub 工具箱')
    expect(definition?.guide?.[0]?.title()).toBe('StarHub 工具箱')
    const registration = register.mock.calls.find(([options]) =>
      options.name === 'sidebar.right.pane.tab' && options.key === definition?.id)
    expect(registration?.[1]).toBeTypeOf('function')
    const tools = registration?.[0].inject() as unknown as { openAsset: (asset: unknown, newTab?: boolean) => Promise<void> }
    const asset = { id: 'server', type: 'ssh', name: 'Server', config: {} }
    await tools.openAsset(asset)
    expect(openResource).toHaveBeenCalledWith(
      'dsh-resource://starhub-workbench/asset/server', { kind: 'starhub-workbench' },
    )
    expect(selectPanel).not.toHaveBeenCalled()
    await tools.openAsset(asset, true)
    expect(openResource).toHaveBeenLastCalledWith(
      'dsh-resource://starhub-workbench/asset/server', { kind: 'starhub-workbench', revealIfOpened: false },
    )
  })

  it('opens SSH execution history from the tools panel and resets it on close', () => {
    const selectPanel = vi.fn()
    const { ctx, register } = fakeContext({ layout: { selectPanel } })
    applyPlugin(ctx)
    const tools = mainByKey(register, 'starhub-tools').inject() as unknown as {
      openExecRecords: () => void
      closeTools: () => void
      hooks: { execRecords: { getSnapshot: () => { viewOpen: boolean; records: unknown[] } } }
    }
    expect(tools.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
    tools.openExecRecords()
    expect(tools.hooks.execRecords.getSnapshot().viewOpen).toBe(true)
    expect(selectPanel).not.toHaveBeenCalled()
    tools.closeTools()
    expect(tools.hooks.execRecords.getSnapshot().viewOpen).toBe(false)
    expect(selectPanel).toHaveBeenCalledWith(null)
  })

  it('tools panel inject selects a subcategory through the selection bridge', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const panelConfig = mainByKey(register, 'starhub-tools')
    const injected = panelConfig.inject() as {
      selectSubcategory: (key: string) => void
      hooks: { selection: { getSnapshot: () => { subcategory: string | null } } }
    }
    expect(injected.selectSubcategory).toBeTypeOf('function')
    injected.selectSubcategory('database')
    expect(injected.hooks.selection.getSnapshot().subcategory).toBe('database')
  })

  it('overlay inject exposes the connection-dialog bridge face', () => {
    const { ctx, register } = fakeContext()
    applyPlugin(ctx)
    const overlayConfig = register.mock.calls.find(c => (c[0] as RegisterOptions).id === 'starhub-overlay')![0]
    const injected = overlayConfig.inject() as {
      openConnectionManager: () => void
      closeConnectionManager: () => void
      onConnectionSaved: (change: unknown) => void
      hooks: { connectionManager: { getSnapshot: () => { open: boolean; asset: null } } }
    }
    expect(injected.openConnectionManager).toBeTypeOf('function')
    expect(injected.closeConnectionManager).toBeTypeOf('function')
    expect(injected.onConnectionSaved).toBeTypeOf('function')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: false, asset: null })
    injected.openConnectionManager()
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: true, asset: null })

    const tools = mainByKey(register, 'starhub-tools').inject() as {
      openConnectionManager: (asset: undefined, initialKind: 'docker') => void
      hooks: { selection: { getSnapshot: () => { subcategory: string | null } } }
    }
    tools.openConnectionManager(undefined, 'docker')
    expect(injected.hooks.connectionManager.getSnapshot()).toEqual({ open: true, asset: null, initialKind: 'docker' })
    stubHostBridge(() => [])
    injected.onConnectionSaved({ kind: 'created', asset: { id: 'redis-1', type: 'db', name: 'Redis', config: { dbType: 'redis' } } })
    expect(tools.hooks.selection.getSnapshot().subcategory).toBe('database')
  })

  it('opens an asset in the native sidebar when the tools panel covers a selected session', async () => {
    let visibleSession: string | undefined
    const openResource = vi.fn()
    const selectPanel = vi.fn((panel: string | null) => { visibleSession = panel === null ? 's1' : undefined })
    const { ctx, register, registerTabType } = fakeContext({
      layout: { selectPanel },
      sessions: { list: {
        getSnapshot: () => ({ ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }),
        subscribe: () => () => {},
      } },
      sidebarRight: { mounted: { getSnapshot: () => visibleSession }, openResource },
    })
    const openSpy = vi.spyOn(window, 'open')
    applyPlugin(ctx)
    const tools = mainByKey(register, 'starhub-tools').inject() as { openAsset: (asset: unknown) => Promise<void> }
    const asset = { id: 'asset/one', type: 'ssh', name: 'Server', config: {} }
    await tools.openAsset(asset)
    await tools.openAsset(asset)
    expect(selectPanel.mock.calls).toEqual([[null]])
    const address = 'dsh-resource://starhub-workbench/asset/asset%2Fone'
    expect(openResource.mock.calls).toEqual([
      [address, { kind: 'starhub-workbench' }],
      [address, { kind: 'starhub-workbench' }],
    ])
    expect(registerTabType.mock.calls[0]?.[0]).toMatchObject({ kind: 'starhub-workbench', keepMounted: true })
    expect(register.mock.calls.some(([options]) =>
      options.name === 'sidebar.right.pane.tab' && options.key === 'starhub-workbench',
    )).toBe(true)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('uses the in-shell workbench main panel when there is no selected session', () => {
    const selectPanel = vi.fn()
    const openResource = vi.fn()
    const { ctx, register } = fakeContext({
      layout: { selectPanel },
      sidebarRight: { mounted: { getSnapshot: () => undefined }, openResource },
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({}) as Window)
    try {
      applyPlugin(ctx)
      const panel = mainByKey(register, 'starhub-tools').inject() as { openAsset: (asset: unknown, newTab?: boolean) => void }
      const esAsset = {
        id: 'es1', type: 'db', name: 'es-1', group_id: null,
        config: { dbType: 'elasticsearch', host: 'h' },
        key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
      }
      panel.openAsset(esAsset)
      expect(openResource).not.toHaveBeenCalled()
      // M2 第 6 步:不再新开窗口/标签页,而是壳内工作台面板的一页。
      expect(openSpy).not.toHaveBeenCalled()
      expect(selectPanel).toHaveBeenCalledWith('starhub-workbench')
      const workbenchConfig = mainByKey(register, 'starhub-workbench') as RegisterOptions
      const injected = workbenchConfig.inject() as {
        hooks: {
          workbench: {
            getSnapshot: () => { pages: Array<{ key: string; title: string; url: string }>; activeKey: string | null }
          }
        }
      }
      const state = injected.hooks.workbench.getSnapshot()
      expect(state.pages.map((page) => page.key)).toEqual(['es1'])
      expect(state.activeKey).toBe('es1')
      expect(state.pages[0]?.url).toContain('starhub-react/index.html?asset=es1')

      panel.openAsset(esAsset, true)
      const duplicate = injected.hooks.workbench.getSnapshot()
      expect(duplicate.pages).toHaveLength(2)
      expect(duplicate.activeKey).not.toBe('es1')
      expect(duplicate.pages[1]?.url).toBe(state.pages[0]?.url)
      panel.openAsset(esAsset)
      expect(injected.hooks.workbench.getSnapshot().pages).toHaveLength(2)
      expect(injected.hooks.workbench.getSnapshot().activeKey).toBe(duplicate.activeKey)

      // 关掉最后一页:面板让回**会话视图**(v0.132.0:不再回退工具列表)。
      const closePage = injected as unknown as { closePage: (key: string) => void }
      closePage.closePage('es1')
      closePage.closePage(duplicate.activeKey!)
      expect(injected.hooks.workbench.getSnapshot().pages).toEqual([])
      expect(selectPanel).toHaveBeenLastCalledWith(null)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('registers the @ asset input source', () => {
    const { ctx, registerSource } = fakeContext()
    applyPlugin(ctx)
    const sources = registerSource.mock.calls.map(c => c[0])
    expect(sources).toHaveLength(1)
    // rc.2 InputTriggerSource 以 name 标识 source(无顶层 id 字段)。
    expect(sources[0]).toMatchObject({ name: STARHUB_ASSET_SOURCE })
  })

  // 资产右键「引用到当前对话框」(v0.103.0):apply 层注入面 insertAssetReference
  // 的装配语义——轻绑定 settings 上下文 + 引用 chip 插入草稿末尾。
  const refAsset = {
    id: 'a1', type: 'ssh', name: 'prod-server', group_id: null,
    config: { host: '10.0.0.5', username: 'deploy' },
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }

  function referenceContext(inputStub: { insertReference: ReturnType<typeof vi.fn>; setDraft: ReturnType<typeof vi.fn> }) {
    const { writer, update: settingsUpdate, mutate: settingsMutate } = createSettingsWriter()
    const input = {
      ...inputStub,
      addImages: vi.fn(() => true),
      state: { getSnapshot: () => ({ draft: '查一下 ', draftRev: 3 }) },
    }
    const harness = fakeContext({
      remote: { settings: writer },
      sessions: {
        list: {
          // 0.1.7:当前会话 = mainView 保留的会话(currentSessionId 推导)。
          getSnapshot: () => ({
            ids: ['s1'],
            byId: { s1: { retainedBy: { mainView: 1 } } },
            phase: 'ready',
            projectionsBySession: {},
          }),
          subscribe: () => () => {},
        },
        binding: vi.fn(() => ({ ctx: {} })),
      },
      conversation: {
        createDrafts: vi.fn(() => []),
        releaseDraftAttachments: vi.fn(),
        input: { for: vi.fn(() => input) },
      },
    })
    return { ...harness, settingsUpdate, settingsMutate }
  }

  it('tools panel inject references an asset into the current conversation (chip + light binding)', () => {
    const insertReference = vi.fn(() => true)
    const setDraft = vi.fn()
    const { ctx, register, settingsMutate } = referenceContext({ insertReference, setDraft })
    applyPlugin(ctx)
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    panel.insertAssetReference(refAsset)
    // 轻绑定:按会话写 bindings[sessionId](与 @ pick 同一通道,路径带会话 id)
    const written = lastBinding(settingsMutate)
    expect(written.sessionId).toBe('s1')
    expect(written.binding).toMatchObject({ assetId: 'a1', assetName: 'prod-server' })
    // chip 插在草稿末尾(span 从 draft 末起,带 pick 时刻 draftRev)
    expect(insertReference).toHaveBeenCalledWith(
      { source: STARHUB_ASSET_SOURCE, ref: 'a1', label: 'prod-server (deploy@10.0.0.5)', clipboardText: '@prod-server' },
      { start: 4, end: 4, draftRev: 3 },
    )
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('falls back to plain-text append when the input machine refuses the chip', () => {
    const insertReference = vi.fn(() => false)
    const setDraft = vi.fn()
    const { ctx, register } = referenceContext({ insertReference, setDraft })
    applyPlugin(ctx)
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    // Docker 资产:纯文本回退同样带 [Docker] 删除保护标注
    panel.insertAssetReference({ ...refAsset, id: 'd1', type: 'docker', name: 'local-docker', config: {} })
    expect(setDraft).toHaveBeenCalledWith('查一下 @local-docker [Docker] ')
  })

  it('binds the exact SSH terminal to the current conversation before updating its draft', async () => {
    const insertReference = vi.fn(() => true)
    const setDraft = vi.fn()
    const bind = Promise.withResolvers<{ ok: boolean }>()
    const invoke = vi.fn((command: string) => command === 'get_assets' ? [refAsset] : bind.promise)
    stubHostBridge(invoke)
    const { ctx, register, settingsMutate } = referenceContext({ insertReference, setDraft })
    applyPlugin(ctx)
    const workbench = mainByKey(register, 'starhub-workbench').inject() as {
      referenceTerminal: (assetId: string, terminalSessionId: string) => Promise<void>
    }
    const pending = workbench.referenceTerminal('a1', 'a1__actual')
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('bind_asset_context', {
        assetId: 'a1', sessionId: 's1', terminalSessionId: 'a1__actual',
      })
    })
    expect(setDraft).not.toHaveBeenCalled()
    expect(insertReference).not.toHaveBeenCalled()
    bind.resolve({ ok: true })
    await pending
    expect(lastBinding(settingsMutate)).toMatchObject({ sessionId: 's1', binding: { assetId: 'a1' } })
    expect(insertReference).toHaveBeenCalledWith(
      { source: STARHUB_ASSET_SOURCE, ref: 'a1', label: 'prod-server (deploy@10.0.0.5)', clipboardText: '@prod-server' },
      { start: 4, end: 4, draftRev: 3 },
    )
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('reports when there is no current conversation to reference', () => {
    const { writer, update: settingsUpdate, mutate: settingsMutate } = createSettingsWriter()
    const { ctx, register } = fakeContext({ remote: { settings: writer } })
    applyPlugin(ctx)
    // apply 启动期的记忆开关初始同步也会写一次 settings,先清掉再断言本路径不写
    settingsUpdate.mockClear()
    const panel = mainByKey(register, 'starhub-tools').inject() as { insertAssetReference: (asset: unknown) => void }
    expect(() => panel.insertAssetReference(refAsset)).toThrow('请先打开一个对话。')
    expect(settingsUpdate).not.toHaveBeenCalled()
    expect(settingsMutate).not.toHaveBeenCalled()
  })

  it('references the second workbench tab and never falls back to the first while the second is disconnected', async () => {
    const insertReference = vi.fn(() => true)
    const { ctx, register } = referenceContext({ insertReference, setDraft: vi.fn() })
    const invoke = vi.fn(() => ({ ok: true }))
    stubHostBridge(invoke)
    applyPlugin(ctx)
    const tools = mainByKey(register, 'starhub-tools').inject() as {
      insertAssetReference: (asset: unknown) => void | Promise<void>
    }
    const { trackTerminalFrame } = mainByKey(register, 'starhub-workbench').inject() as {
      trackTerminalFrame: TerminalFrameTracker
    }
    const first = document.createElement('iframe')
    const second = document.createElement('iframe')
    document.body.append(first, second)
    const frames = [first, second]
    const tracks = frames.map(frame => trackTerminalFrame(frame, 'a1', 's1'))
    const respond = (id: string) => (event: Event) => { (event as CustomEvent<(id: string) => void>).detail(id) }
    const secondResponse = respond('a1__second')
    try {
      first.contentWindow?.addEventListener('starhub:connected-terminal', respond('a1__first'))
      second.contentWindow?.addEventListener('starhub:connected-terminal', secondResponse)
      for (const track of tracks) track.activate()
      await tools.insertAssetReference(refAsset)
      expect(invoke).toHaveBeenCalledWith('bind_asset_context', {
        assetId: 'a1', sessionId: 's1', terminalSessionId: 'a1__second',
      })
      second.contentWindow?.removeEventListener('starhub:connected-terminal', secondResponse)
      expect(() => tools.insertAssetReference(refAsset)).toThrow('连接 SSH 后即可引用此终端')
      expect(insertReference).toHaveBeenCalledTimes(1)
    } finally {
      for (const track of tracks) track.dispose()
      for (const frame of frames) frame.remove()
    }
  })


  it('inject list declares the required services', () => {
    expect(injectList).toContain('slots')
    expect(injectList).toContain('connection')
    expect(injectList).toContain('inputTriggers')
    expect(injectList).toContain('sessions')
    expect(injectList).toContain('workspaces')
    expect(injectList).toContain('conversation')
    expect(injectList).toContain('remote')
    // 0.1.7:ask-ai 的会话聚焦走 view owner 的导航面(uiWorkspace.openSession)。
    expect(injectList).toContain('uiWorkspace')
    // 0.1.6 Typert gateway:每个 Remote 命名空间是独立 service,
    // ctx.remote.<ns> 要求 fiber 声明点号全名,否则 apply 抛
    // "cannot get property … without inject"(v0.121.7 启动事故)。
    expect(injectList).toContain('remote.settings')
    // v0.123.2:工具面板迁主面板,入口/执行 跳转走 ui-layout 的 layout 服务。
    expect(injectList).toContain('layout')
  })
})
