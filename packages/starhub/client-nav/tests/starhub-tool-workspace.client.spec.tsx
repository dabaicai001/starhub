// @vitest-environment jsdom
/**
 * Covers connection search and filters, loading and recovery, and opening a
 * connection in the workbench or in the system browser. 资产/选择状态走
 * inject hooks 舱位(session-maybe 无会话分支不下发注册侧 store),测试
 * 直接驱动这两份裸 source。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  createToolSelectionBridge, type StarHubAssetListState, type ToolSelection,
} from '../src/client/store.ts'
import type { ExecRecordsState } from '../src/client/conn/exec-records.ts'
import { StarHubToolWorkspace } from '../src/client/StarHubToolWorkspace.tsx'
import { hostBridgeCalls, restoreHostBridge, stubHostBridge } from './host-bridge.ts'

afterEach(() => {
  cleanup()
  restoreHostBridge()
})

/** 模拟无宿主桥:移除 fetch 使 isTauriRuntime() 为 false(替代旧「无 Tauri internals」预览态)。 */
async function withoutHostBridge<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  Reflect.deleteProperty(globalThis, 'fetch')
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Compose the full workspace props share: a real selection bridge plus an
 * asset-list bare source (both stand in for the apply-owned holders injected
 * through the hooks compartment), plus the session-maybe standard kit stubs
 * the component's PropsRuntime requires (the component itself only reads the
 * injected face).
 */
function workspaceProps() {
  const assets = createSnapshotStore<StarHubAssetListState>({ assets: [], loading: false, error: null, preview: false })
  const bridge = createToolSelectionBridge()
  const execRecords = createSnapshotStore<ExecRecordsState>({ viewOpen: false, records: [] })
  const useAssets = <S,>(sel: (s: StarHubAssetListState) => S) => sel(assets.getSnapshot())
  const useSelection = <S,>(sel: (s: ToolSelection) => S) => sel(bridge.source.getSnapshot())
  const useExecRecords = <S,>(sel: (s: ExecRecordsState) => S) => sel(execRecords.getSnapshot())
  return {
    assets,
    bridge,
    execRecords,
    refreshAssets: vi.fn(),
    openConnectionManager: vi.fn(),
    dismissConnectionChange: vi.fn(),
    openExecRecords: vi.fn(),
    clearExecRecords: vi.fn(),
    disconnectExecSession: vi.fn(),
    closeTools: vi.fn(),
    selectSubcategory: vi.fn(),
    insertAssetReference: vi.fn(),
    useAssets,
    useSelection,
    useExecRecords,
    // settings.update stub: the tool-context sync effect calls it and must
    // not throw in jsdom (no real wire).
    api: { settings: { update: () => Promise.resolve({ result: { ok: true } }) } } as never,
    openAsset: bridge.openAsset,
    useSession: (() => undefined) as never,
    useSessions: (() => undefined) as never,
    sessionId: undefined as never,
    useProjection: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useWorkspaces: (() => undefined) as never,
    // 0.1.6/0.1.7 GlobalStandardProps 新增席位:本组件不消费,给最小桩。
    usePanelInfo: (() => undefined) as never,
    useSessionPendingInteraction: (() => undefined) as never,
    useResource: (() => undefined) as never,
    useSessionStatus: (() => undefined) as never,
    useSessionRetainInfo: (() => undefined) as never,
  }
}

const sshAsset = {
  id: 'a1',
  type: 'ssh',
  name: 'prod-server',
  group_id: null,
  config: { host: '10.0.0.5', username: 'deploy' },
  key_id: null,
  tags: [],
  favorite: false,
  last_used_at: null,
  created_at: 0,
  updated_at: 0,
}

describe('StarHubToolWorkspace', () => {
  it('shows all connections when no category is selected and searches by host and type', () => {
    const props = workspaceProps()
    props.assets.update(draft => {
      draft.assets = [sshAsset, { ...sshAsset, id: 'r1', type: 'db', name: 'cache', config: { dbType: 'redis', host: '10.0.0.8' } }]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByRole('button', { name: /全部连接/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('prod-server')).toBeTruthy()
    expect(screen.getByText('cache')).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: '搜索名称、主机或类型' })
    fireEvent.change(search, { target: { value: '10.0.0.8 REDIS' } })
    expect(screen.queryByText('prod-server')).toBeNull()
    expect(screen.getByText('cache')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.getByText('prod-server')).toBeTruthy()
  })

  it('loads connections on mount and filters the loaded list on category switch', () => {
    const props = workspaceProps()
    const view = render(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(1)
    props.bridge.selectSubcategory('terminal')
    view.rerender(<StarHubToolWorkspace {...props} />)
    expect(props.refreshAssets).toHaveBeenCalledTimes(1)
  })

  it('renders the loading state while fetching', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.loading = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/加载资产/)).toBeTruthy()
  })

  it('renders the error state with a retry button when loading failed', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.error = 'boom' })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByRole('alert').textContent).toContain('连接列表刷新失败：boom')
    screen.getByText('重试').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + retry
  })

  it('renders the browser-preview hint instead of an error in preview mode', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.preview = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('浏览器预览模式')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the android panel (no asset list) for the android subcategory', async () => {
    await withoutHostBridge(async () => {
      const props = workspaceProps()
      props.bridge.selectSubcategory('android')
      render(<StarHubToolWorkspace {...props} />)
      // Android 子类无资产概念:展开即 AndroidPanel;无宿主桥(测试环境)时
      // 面板落到浏览器预览提示而不是资产加载态。
      await waitFor(() => expect(screen.getByText(/浏览器里/)).toBeTruthy())
      expect(screen.queryByText(/暂无 Android 连接/)).toBeNull()
    })
  })

  it('shows the per-subcategory empty state with a 新建连接 button when no assets match', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无 Docker 连接/)).toBeTruthy()
  })

  it('renders the header with the matching count and opens the connection manager from the header + button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByRole('button', { name: /终端.*1/ })).toBeTruthy()
    screen.getByRole('button', { name: '新建连接' }).click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
  })

  it('renders matching asset rows with badge and subtitle, filtering per subcategory', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    // 列表行徽标与列头都含子类名,至少两处
    expect(screen.getAllByText('终端').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('deploy@10.0.0.5')).toBeTruthy()
  })

  it('renders subtitle fallbacks for host-only, database-only and empty configs', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => {
      d.assets = [
        { ...sshAsset, id: 'h1', config: { host: '10.0.0.6' } },
        { ...sshAsset, id: 'd1', config: { database: 'orders' } },
        { ...sshAsset, id: 'e1', config: {} },
      ]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('10.0.0.6')).toBeTruthy()
    expect(screen.getByText('orders')).toBeTruthy()
  })

  it('shows the concrete database type badge instead of the generic 数据库 label', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('database')
    props.assets.update((d) => {
      d.assets = [
        { ...sshAsset, id: 'm1', type: 'db', name: 'mysql-box', config: { dbType: 'mysql', host: '10.0.0.1' } },
        { ...sshAsset, id: 'r1', type: 'db', name: 'redis-box', config: { dbType: 'redis', host: '10.0.0.2' } },
        { ...sshAsset, id: 'e1', type: 'db', name: 'es-box', config: { dbType: 'elasticsearch', host: '10.0.0.3' } },
      ]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('MySQL')).toBeTruthy()
    expect(screen.getByText('Redis')).toBeTruthy()
    expect(screen.getByText('ES')).toBeTruthy()
  })

  it('skips the settings sync when the api face is absent', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('终端')).toBeTruthy()
  })

  it('refreshes from the header refresh button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    screen.getByTitle('刷新').click()
    expect(props.refreshAssets).toHaveBeenCalledTimes(2) // mount + refresh button
  })

  it('opens the connection manager from the empty-state 新建连接 button', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('docker')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    // 头部与空态各有一个「新建连接」,空态按钮在列表区域
    const buttons = screen.getAllByText('新建连接')
    buttons[buttons.length - 1]!.click()
    expect(props.openConnectionManager).toHaveBeenCalledWith(undefined, 'docker')
    buttons[0]!.click()
    expect(props.openConnectionManager).toHaveBeenNthCalledWith(2, undefined, 'docker')
  })

  it('shows a newly created connection and opens it directly even if refreshing the list failed', async () => {
    const props = workspaceProps()
    const openAsset = vi.fn()
    props.bridge.selectSubcategory('terminal')
    props.assets.update(draft => {
      draft.assets = [sshAsset]
      draft.error = 'offline'
      draft.recentChange = { kind: 'created', id: sshAsset.id, name: sshAsset.name }
    })
    render(<StarHubToolWorkspace {...props} openAsset={openAsset} />)
    expect(screen.getByText('已新建连接 prod-server').getAttribute('role')).toBe('status')
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.getByTitle('在工作台中打开 prod-server')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开工作台', exact: true }))
    expect(openAsset).toHaveBeenCalledWith(sshAsset)
    await waitFor(() => { expect(props.dismissConnectionChange).toHaveBeenCalledOnce() })
  })

  it('disables the external browser action while its launch is pending', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const launch = Promise.withResolvers<{ ok: true }>()
    // 桌面壳里页面 origin 是 dsh-app://app,真实宿主源要靠桥内 host_origin 问出来
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'host_origin') return { origin: 'http://127.0.0.1:19387' }
      if (cmd === 'open_external_url') return launch.promise
      return {}
    })
    stubHostBridge(invoke)
    try {
      const props = workspaceProps()
      props.bridge.selectSubcategory('terminal')
      props.assets.update((d) => { d.assets = [sshAsset] })
      render(<StarHubToolWorkspace {...props} />)
      const row = screen.getByText('prod-server')
      fireEvent.click(screen.getByRole('button', { name: 'prod-server 的更多操作' }))
      fireEvent.click(screen.getByText('在浏览器中打开'))
      fireEvent.contextMenu(row)
      expect(screen.getByText('在浏览器中打开').closest('button')?.disabled).toBe(true)
      await vi.waitFor(() => { expect(invoke).toHaveBeenCalledWith('open_external_url', expect.anything()) })
      expect(hostBridgeCalls().map(call => call.cmd)).toEqual(['host_origin', 'open_external_url'])
      expect(open).not.toHaveBeenCalled()
      launch.resolve({ ok: true })
      await waitFor(() => { expect(screen.getByText('在浏览器中打开').closest('button')?.disabled).toBe(false) })
      expect(props.bridge.source.getSnapshot().assetId).toBeNull()
    } finally {
      restoreHostBridge()
      open.mockRestore()
    }
  })

  it('opens the workbench on a normal row click without launching the browser', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const invoke = vi.fn(() => ({}))
    stubHostBridge(invoke)
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.click(screen.getByText('prod-server'))
    const sel = props.bridge.source.getSnapshot()
    expect(sel.assetId).toBe('a1')
    expect(sel.routePrefix).toBe('/ssh')
    expect(sel.instanceId).toMatch(/^a1__\d+$/)
    expect(open).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('surfaces an error when the inline workbench action fails', async () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    const openAsset = vi.fn().mockRejectedValue(new Error('panel unavailable'))
    render(<StarHubToolWorkspace {...props} openAsset={openAsset} />)
    fireEvent.click(screen.getByTitle('在工作台中打开 prod-server'))
    expect(openAsset).toHaveBeenCalledWith(sshAsset)
    expect(await screen.findByText(/打开工作台失败.*panel unavailable/)).toBeTruthy()
  })

  it('opens the connection dialog in edit mode from the row edit button (without opening the page)', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    screen.getByLabelText('编辑 prod-server').click()
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
    expect(props.openConnectionManager).toHaveBeenCalledWith(sshAsset)
    // 编辑钮不触发打开操作页
    expect(props.bridge.source.getSnapshot().assetId).toBeNull()
  })

  it('copies connection info from the row context menu and reverts the label after 1.5s', async () => {
    vi.useFakeTimers()
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    const write = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<StarHubToolWorkspace {...props} />)
      const openMenu = () => fireEvent.contextMenu(screen.getByText('prod-server'))
      openMenu()
      fireEvent.click(screen.getByText('复制连接信息'))
      // 剪贴板写成功 → copied 置位;菜单已关闭,重开可见「已复制」标签
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledWith('prod-server deploy@10.0.0.5')
      openMenu()
      expect(screen.getByText('已复制')).toBeTruthy()
      // 1.5s 定时器回退标签
      await vi.advanceTimersByTimeAsync(1500)
      expect(screen.getByText('复制连接信息')).toBeTruthy()
    } finally {
      vi.useRealTimers()
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('opens the connection dialog in edit mode from the row context menu delete entry', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.contextMenu(screen.getByText('prod-server'))
    fireEvent.click(screen.getByText('删除'))
    expect(props.openConnectionManager).toHaveBeenCalledTimes(1)
    expect(props.openConnectionManager).toHaveBeenCalledWith(sshAsset)
  })

  it('routes the row context-menu 引用到当前对话框 entry to insertAssetReference', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.contextMenu(screen.getByText('prod-server'))
    fireEvent.click(screen.getByText('引用到当前对话框'))
    // 引用经注入面回调分发(真正的 chip 插入 + 轻绑定在 apply 层)
    expect(props.insertAssetReference).toHaveBeenCalledTimes(1)
    expect(props.insertAssetReference).toHaveBeenCalledWith(sshAsset)
    // 引用不触发打开操作页,也不进连接对话框
    expect(props.bridge.source.getSnapshot().assetId).toBeNull()
    expect(props.openConnectionManager).not.toHaveBeenCalled()
  })

  it('routes the row context-menu 编辑 entry to the connection dialog', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [{ ...sshAsset, id: 'e1', config: {} }] })
    render(<StarHubToolWorkspace {...props} />)
    const openMenu = () => fireEvent.contextMenu(screen.getByText('prod-server'))
    // 编辑:走连接对话框编辑模式
    openMenu()
    fireEvent.click(screen.getByText('编辑'))
    expect(props.openConnectionManager).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
  })

  it('opens the asset standalone page through the host sidecar with the host origin from the context menu', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    // 桌面壳里页面 origin 是 dsh-app://app,真实宿主源要靠桥内 host_origin 问出来
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'host_origin') return { origin: 'http://127.0.0.1:19387' }
      if (cmd === 'open_external_url') return { ok: true }
      return {}
    })
    stubHostBridge(invoke)
    try {
      const props = workspaceProps()
      props.bridge.selectSubcategory('terminal')
      props.assets.update((d) => { d.assets = [sshAsset] })
      render(<StarHubToolWorkspace {...props} />)
      fireEvent.contextMenu(screen.getByText('prod-server'))
      fireEvent.click(screen.getByText('在浏览器中打开'))
      await vi.waitFor(() => { expect(invoke).toHaveBeenCalledWith('open_external_url', expect.anything()) })
      // 交给 sidecar 唤起系统浏览器(与壳的弹窗策略无关),URL 用宿主源还原
      expect(hostBridgeCalls().map(call => call.cmd)).toEqual(['host_origin', 'open_external_url'])
      expect(hostBridgeCalls()[1]?.args).toEqual({
        url: 'http://127.0.0.1:19387/starhub-react/index.html?asset=a1&workbench=ssh',
      })
      expect(open).not.toHaveBeenCalled()
      // 不开壳内页、不进连接对话框
      expect(props.bridge.source.getSnapshot().assetId).toBeNull()
      expect(props.openConnectionManager).not.toHaveBeenCalled()
    } finally {
      restoreHostBridge()
      open.mockRestore()
    }
  })

  it('falls back to window.open when the host has no open_external_url (旧宿主/预览)', async () => {
    const replace = vi.fn()
    const popup = { opener: window, location: { replace } }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    // 旧宿主:两个桥内命令都不认 → tauriInvoke reject → 用页面自身 origin 回落
    stubHostBridge(() => { throw new Error('method not found') })
    try {
      const props = workspaceProps()
      props.bridge.selectSubcategory('terminal')
      props.assets.update((d) => { d.assets = [{ ...sshAsset, config: {} }] })
      render(<StarHubToolWorkspace {...props} />)
      fireEvent.contextMenu(screen.getByText('prod-server'))
      fireEvent.click(screen.getByText('在浏览器中打开'))
      await waitFor(() => { expect(replace).toHaveBeenCalledWith(
        `${window.location.origin}/starhub-react/index.html?asset=a1&workbench=ssh`,
      ) })
      expect(open).toHaveBeenCalledWith('about:blank', '_blank')
      expect(popup.opener).toBeNull()
      expect(screen.queryByText(/无法打开系统浏览器/)).toBeNull()
    } finally {
      restoreHostBridge()
      open.mockRestore()
    }
  })

  it('surfaces a visible notice and copies the HOST link when the browser cannot be launched', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const write = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    // 宿主源问得到,但唤起系统浏览器失败(如 spawn 失败)+ 壳拦下 window.open
    stubHostBridge((cmd: string) => {
      if (cmd === 'host_origin') return { origin: 'http://127.0.0.1:19387' }
      throw new Error('唤起系统浏览器失败(rundll32.exe): 拒绝访问')
    })
    try {
      const props = workspaceProps()
      props.bridge.selectSubcategory('terminal')
      props.assets.update((d) => { d.assets = [{ ...sshAsset, config: {} }] })
      render(<StarHubToolWorkspace {...props} />)
      fireEvent.contextMenu(screen.getByText('prod-server'))
      fireEvent.click(screen.getByText('在浏览器中打开'))
      // 两条路都不通时不再静默:面板给出可见提示,并把**宿主源**链接落到剪贴板
      await screen.findByText('无法打开系统浏览器，已复制工作台链接。')
      expect(write).toHaveBeenCalledWith(
        'http://127.0.0.1:19387/starhub-react/index.html?asset=a1&workbench=ssh',
      )
    } finally {
      restoreHostBridge()
      open.mockRestore()
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('keeps the copy label when the clipboard write fails', async () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [{ ...sshAsset, config: {} }] })
    // 剪贴板拒绝写(writeText reject)→ writeClipboard 返回 false → 不置 copied
    const write = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
    try {
      render(<StarHubToolWorkspace {...props} />)
      fireEvent.contextMenu(screen.getByText('prod-server'))
      fireEvent.click(screen.getByText('复制连接信息'))
      await vi.waitFor(() =>{  expect(write).toHaveBeenCalled() })
      // 无副标题资产:复制文案只有名称;写失败不置 copied
      expect(write).toHaveBeenCalledWith('prod-server')
      expect(await screen.findByText('复制连接信息失败，请重试。')).toBeTruthy()
      fireEvent.contextMenu(screen.getByText('prod-server'))
      expect(screen.getByText('复制连接信息')).toBeTruthy()
      expect(screen.queryByText('已复制')).toBeNull()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('renders the asset list when the exec view is closed', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.assets.update((d) => { d.assets = [sshAsset] })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('prod-server')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'SSH 执行记录' }))
    expect(props.openExecRecords).toHaveBeenCalledOnce()
  })

  it('switches to the exec-records view when the bridge is open and hides the asset list', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:asset-1:ssh', conversationId: 'conv-A', command: 'ls -la /var/log', output: 'total 48\nrc.service', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText('SSH 执行记录')).toBeTruthy()
    expect(screen.getByText('asset-1')).toBeTruthy()
    expect(screen.getByText('$ ls -la /var/log')).toBeTruthy()
    // 默认收起:输出不出现在 DOM
    expect(screen.queryByText(/total 48/)).toBeNull()
    expect(screen.queryByText('新建连接')).toBeNull()
  })

  it('expands a record on click to show the command output, collapses on second click', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:asset-1:ssh', conversationId: 'conv-A', command: 'df -h', output: '/dev/sda1 40G 20G', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    const head = screen.getByTitle(/^asset-1\(点击/)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    expect(screen.getByText('/dev/sda1 40G 20G')).toBeTruthy()
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(head)
    expect(screen.queryByText('/dev/sda1 40G 20G')).toBeNull()
  })

  it('passes the row close button through to disconnectExecSession with the connection id', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:a1:ssh', conversationId: 'conv-A', command: 'ls', output: '', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '断开 a1 的连接并移除记录' }))
    expect(props.disconnectExecSession).toHaveBeenCalledWith('dsh:a1:ssh')
  })

  it('clears all records through the injected callback and closes the panel via 关闭并返回会话', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => {
      d.viewOpen = true
      d.records = [{ sessionId: 'dsh:a1:ssh', conversationId: 'conv-A', command: 'ls', output: '', at: 0 }]
    })
    render(<StarHubToolWorkspace {...props} />)
    fireEvent.click(screen.getByText('清空'))
    expect(props.clearExecRecords).toHaveBeenCalledTimes(1)
    // v0.132.0:执行记录视图的 × 与面板 × 同义 = 关闭面板回会话,不回工具列表。
    fireEvent.click(screen.getByLabelText('关闭并返回会话'))
    expect(props.closeTools).toHaveBeenCalledTimes(1)
  })

  it('renders the exec view empty state with 清空 disabled when no records exist', () => {
    const props = workspaceProps()
    props.execRecords.update((d) => { d.viewOpen = true })
    render(<StarHubToolWorkspace {...props} />)
    expect(screen.getByText(/暂无记录/)).toBeTruthy()
    const clear = screen.getByText('清空') as HTMLButtonElement
    expect(clear.disabled).toBe(true)
  })

  it('switches category filters and returns to all connections', () => {
    const props = workspaceProps()
    props.bridge.selectSubcategory('terminal')
    render(<StarHubToolWorkspace {...props} />)
    const terminalRow = screen.getByRole('button', { name: /终端/ })
    expect(terminalRow.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /全部连接/ }))
    expect(props.selectSubcategory).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByRole('button', { name: /数据库/ }))
    expect(props.selectSubcategory).toHaveBeenCalledWith('database')
  })

})
