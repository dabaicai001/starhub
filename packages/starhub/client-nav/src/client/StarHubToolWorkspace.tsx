/**
 * StarHub 工具面板(v0.123.2 起为**主面板**):侧栏「工具」行
 * (sidebar.panellist,order 1 紧随「插件」之下)经 layout.selectPanel 切换,
 * 本组件挂 ui-layout 的 root-scope `main` keyed 槽，显示可按分类筛选和搜索的连接列表。
 * Android 设备使用独立的设备面板。
 * 点击连接默认打开壳内工作台。右键可选择在系统浏览器中打开,
 * 行尾提供编辑和更多操作，
 * 经 openConnectionManager(asset) 打开连接对话框的编辑模式;列头带资产数、
 * 刷新与「新建连接」入口,右上角 × 回会话视图(selectPanel(null))。
 *
 * 资产行右键菜单:在浏览器中打开 / 引用到当前对话框(插入 `@` 引用 chip 并轻绑定资产上下文,与 `@` pick
 * 同语义)/ 编辑 / 复制连接信息(名称 + user@host 到剪贴板)/ 删除(删除复用连接
 * 对话框编辑模式内的两步确认删除入口,不在菜单里直接执行破坏性操作)。
 *
 * 浏览器唤起走**宿主 sidecar**(`ui.open_external_url` → 平台默认浏览器):壳的
 * `window.open` 处理器只把 http/https 交 `shell.openExternal`,而内置浏览器的 guest
 * 会话禁止请求宿主源(见 browser-guests.ts);两条路都不通时把链接落到剪贴板并给出
 * 可见提示。
 *
 * 浏览器预览(无 Tauri IPC)时 refresh 落入 preview 态,这里展示预览提示
 * 而不是红错;其他拉取失败给错误 + 重试。
 *
 * 历史形态:rc.2 起先挂 shell.overlay 浮层(侧栏底部 footer.action 入口 +
 * toolsPanel 开关桥);v0.123.2 迁主面板,开关桥删除。
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'main' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconCloseOutlineMedium, IconCopyOutlineMedium, IconEditOutlineMedium, IconEllipsisOutlineMedium,
  IconLinkOutlineMedium, IconLoadingOutlineMedium, IconPlusOutlineMedium, IconRefreshOutlineMedium,
  IconRightUpOutlineMedium, IconSearchOutlineMedium, IconTrashOutlineMedium,
  writeClipboard, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, assetRowBadge, assetSubtitle, assetWindowUrl, type StarHubAsset } from './sections.ts'
import { tauriInvoke } from './tauri.ts'
import type { ConnectionManagerOverlay, RustAsset, StarHubAssetListState, ToolSelection } from './store.ts'
import { ContextMenu, useContextMenu } from './ContextMenu.tsx'
import { ExecRecordList } from './conn/ExecRecordList.tsx'
import type { ExecRecordsState } from './conn/exec-records.ts'
import { AndroidPanel } from './android/AndroidPanel.tsx'
import { interactionMessages } from './interaction-messages.ts'
import css from './StarHubToolWorkspace.module.css'

/**
 * 问宿主要真实源(桌面壳里页面 origin 是 `dsh-app://app`,不是宿主源)。
 *
 * 壳把 `dsh-app://app/<path>` 反代到真正的宿主,但页面自己看不到那个源:直接拿
 * `window.location.origin` 拼绝对 URL 会得到 `dsh-app://app/...`,既过不了
 * sidecar 的 http/https 校验,也进不了 `shell.openExternal`。宿主的 `host_origin`
 * 桥内命令用请求 Host 头还原真实源;预览 / 旧宿主取不到时退回页面自身 origin。
 * @returns 形如 `http://127.0.0.1:19387` 的源。
 */
async function hostOrigin(): Promise<string> {
  try {
    const result = await tauriInvoke<{ origin?: unknown }>('host_origin')
    const origin = typeof result.origin === 'string' ? result.origin : ''
    if (origin !== '') return origin
  } catch {
    // 旧宿主没有该命令 / 浏览器预览:按页面自身源处理。
  }
  return window.location.origin
}

/**
 * 在系统默认浏览器里打开该资产的独立工作台页(与壳内面板同一个 URL)。
 *
 * 主路径是**宿主 sidecar**(`ui.open_external_url` → Windows
 * `rundll32 url.dll,FileProtocolHandler` / macOS `open` / Linux `xdg-open`):
 * 壳的 `window.open` 处理器虽会把 http/https 转 `shell.openExternal`,但那一环
 * 变异就会静默失败;sidecar 唤起系统浏览器与壳的弹窗/导航策略无关。
 * @param asset - 目标资产(取 id/type/config 组装 URL)。
 * @returns 失败提示文本;`null` = 已交给宿主或浏览器(无需提示)。两条路都不通时
 *   把链接落到剪贴板并回报提示——「点了没反应」这种静默失败不再可能。
 */
async function openAssetInBrowser(asset: StarHubAsset): Promise<string | null> {
  // 绝对 URL 必须用**宿主源**拼:桌面壳里 location.origin 是 dsh-app://app。
  const url = new URL(assetWindowUrl(asset), await hostOrigin())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(interactionMessages().browserAddressUnavailable)
  }
  try {
    await tauriInvoke('open_external_url', { url: url.href })
    return null
  } catch {
    // 浏览器预览可以自己打开标签页；桌面壳通过下方的链接复制回退。
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      // noopener 打开成功也会返回 null。先打开空页，断开 opener 后再导航。
      const popup = window.open('about:blank', '_blank')
      if (popup !== null) {
        popup.opener = null
        popup.location.replace(url.href)
        return null
      }
    }
  }
  // 两条路都没成:不再静默——复制链接并把提示交给面板展示。
  const copied = await writeClipboard(url.href)
  const messages = interactionMessages()
  return copied ? messages.browserLinkCopied : messages.browserLinkFallback(url.href)
}

/** Business face injected by the registration: the connection wire + bridge/asset writes. */
export interface StarHubToolWorkspaceInjected {
  openAsset: (asset: StarHubAsset) => void | Promise<void>
  refreshAssets: () => void
  /** 打开连接对话框:不传资产 = 新建;传资产 = 编辑(含删除入口)。 */
  openConnectionManager: ConnectionManagerOverlay['open']
  /** Close the confirmation shown after a successful connection change. */
  dismissConnectionChange: () => void
  /** 在工具面板中查看当前会话的 SSH 执行记录。 */
  openExecRecords: () => void
  /** 清空当前会话的执行记录(执行记录视图头部「清空」,随会话隔离)。 */
  clearExecRecords: () => void
  /** 断开一条执行记录对应的 SSH 连接并移除其记录(v0.100.1 行尾关闭按钮)。 */
  disconnectExecSession: (sessionId: string) => void
  /** 关闭工具面板:主面板模式 = 回会话视图(layout.selectPanel(null))。 */
  closeTools: () => void
  /** 选中/收起一个子类:null = 全部收起(手风琴,再点当前行收起)。 */
  selectSubcategory: (key: string | null) => void
  /** 把资产作为引用 chip 插入当前会话对话框并轻绑定资产上下文(资产行右键「引用到当前对话框」)。 */
  insertAssetReference: (asset: RustAsset) => void
  hooks: {
    selection: SnapshotStore<ToolSelection>
    assets: SnapshotStore<StarHubAssetListState>
    execRecords: SnapshotStore<ExecRecordsState>
  }
}

/** Full composed props: main-panel runtime share + the injected face (no slot store — see header). */
export type StarHubToolWorkspaceProps =
  & PropsRuntime<'main'>
  & InjectFace<StarHubToolWorkspaceInjected>

/** 单个资产行:打开工作台、编辑连接及右键操作。 */
function AssetRow({ asset, badgeLabel, active, onOpenInPage, onReference, onEdit, onNotice }: {
  asset: RustAsset
  badgeLabel: string
  /** 当前打开(选中)的资产行高亮。 */
  active: boolean
  /** 在宿主内打开工作台。 */
  onOpenInPage: () => void | Promise<void>
  /** 引用到当前对话框:插入 `@` 引用 chip 并轻绑定资产上下文。 */
  onReference: () => void
  onEdit: () => void
  /** 面板级瞬时提示(唤起系统浏览器两条路都不通时给出可见反馈)。 */
  onNotice: (text: string) => void
}) {
  const menu = useContextMenu()
  const messages = interactionMessages()
  const [copied, setCopied] = useState(false)
  const [openingBrowser, setOpeningBrowser] = useState(false)
  const [openingWorkbench, setOpeningWorkbench] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1500)
    return () => { window.clearTimeout(timer) }
  }, [copied])
  const subtitle = assetSubtitle(asset)
  const openInBrowser = async (): Promise<void> => {
    setOpeningBrowser(true)
    try {
      const message = await openAssetInBrowser(asset)
      if (message !== null) onNotice(message)
    } catch (error) {
      onNotice(messages.browserOpenFailed(error instanceof Error ? error.message : String(error)))
    } finally {
      setOpeningBrowser(false)
    }
  }
  const openInPage = async (): Promise<void> => {
    setOpeningWorkbench(true)
    try {
      await onOpenInPage()
    } catch (error) {
      onNotice(messages.workbenchOpenFailed(error instanceof Error ? error.message : String(error)))
    } finally {
      setOpeningWorkbench(false)
    }
  }
  const pending = openingBrowser ? messages.openingBrowser : openingWorkbench ? messages.loadingWorkbench : ''
  const items: MenuEntry[] = [
    { id: 'open-in-browser', label: messages.openInBrowser, icon: <IconRightUpOutlineMedium />, disabled: openingBrowser },
    { id: 'reference', label: messages.referenceConversation, icon: <IconLinkOutlineMedium /> },
    { id: 'edit', label: messages.edit, icon: <IconEditOutlineMedium /> },
    { id: 'copy', label: copied ? messages.copied : messages.copyConnection, icon: <IconCopyOutlineMedium /> },
    { type: 'separator', id: 'asset-delete-separator' },
    // 删除不直接执行:复用连接对话框编辑模式内的两步确认删除入口
    // (delete_asset 命令),避免右键菜单里的无确认破坏性操作。
    { id: 'delete', label: messages.delete, icon: <IconTrashOutlineMedium />, danger: true },
  ]
  return (
    <li className={clsx(css.rowWrap, active && css.active)} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown}>
      <button
        type="button"
        className={css.row}
        title={messages.openInWorkbench(asset.name)}
        aria-current={active ? 'true' : undefined}
        aria-busy={openingWorkbench}
        disabled={openingWorkbench}
        onClick={() => void openInPage()}
      >
        <span className={css.assetText}>
          <span className={css.rowName}>{asset.name}</span>
          {(pending !== '' || subtitle !== '') && (
            <span className={css.rowSub}>{pending || subtitle}</span>
          )}
        </span>
        <span className={css.badge}>
          {pending !== '' ? <IconLoadingOutlineMedium className={css.spin} size={13} /> : badgeLabel}
        </span>
      </button>
      <span className={css.srOnly} role="status">{pending}</span>
      <button
        type="button"
        className={css.iconButton}
        title={messages.editConnection(asset.name)}
        aria-label={messages.editConnection(asset.name)}
        onClick={onEdit}
      >
        <IconEditOutlineMedium size={15} />
      </button>
      <button
        type="button"
        className={css.iconButton}
        title={messages.connectionActions(asset.name)}
        aria-label={messages.connectionActions(asset.name)}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={event => {
          if (menu.open) {
            menu.close()
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          menu.openAt(rect.right, rect.bottom)
        }}
      >
        <IconEllipsisOutlineMedium size={16} />
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        align="end"
        onSelect={(id) => {
          if (id === 'open-in-browser') void openInBrowser()
          else if (id === 'reference') onReference()
          else if (id === 'edit' || id === 'delete') onEdit()
          else if (id === 'copy') {
            const text = subtitle === '' ? asset.name : `${asset.name} ${subtitle}`
            void writeClipboard(text).then((ok) => {
              if (ok) setCopied(true)
              else onNotice(messages.copyFailed)
            })
          }
        }}
        className={css.menuRoot}
      />
    </li>
  )
}

/**
 * Render the searchable connection list and the Android device panel.
 *
 * 文件树/文件查看能力已在 v0.121.8 移除(与 DSH 主壳自带的 fs 工具/`@`
 * 文件引用源重复),壳内文件浏览请用 DSH 侧能力。
 *
 * 工具栏可打开当前会话的 SSH 执行记录,数据由 apply 层订阅并归档。
 * @param props - composed slot props (main-panel runtime share + injected face).
 * @returns the panel content (rendered only while the sidebar row selects it).
 */
export function StarHubToolWorkspace({
  openAsset, refreshAssets, openConnectionManager, dismissConnectionChange,
  openExecRecords, clearExecRecords, disconnectExecSession,
  closeTools, selectSubcategory, insertAssetReference,
  useSelection, useAssets, useExecRecords,
}: StarHubToolWorkspaceProps) {
  const assets = useAssets(s => s.assets)
  const loading = useAssets(s => s.loading)
  const error = useAssets(s => s.error)
  const preview = useAssets(s => s.preview)
  const recentChange = useAssets(s => s.recentChange)
  const activeSubcategory = useSelection(s => s.subcategory)
  const activeAssetId = useSelection(s => s.assetId)
  const activeCategory = STARHUB_SUBCATEGORIES.find(item => item.key === activeSubcategory)
  const createdAsset = recentChange?.kind === 'created' ? assets.find(asset => asset.id === recentChange.id) : undefined
  const messages = interactionMessages()
  const changeMessages = {
    created: messages.connectionCreated,
    updated: messages.connectionUpdated,
    deleted: messages.connectionDeleted,
  }
  // 执行记录视图(v0.100.0):hook 未提供时视为关闭 + 空列表(独立渲染兼容)。
  const execViewOpen = useExecRecords?.(s => s.viewOpen) ?? false
  const execRecords = useExecRecords?.(s => s.records) ?? []
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // 面板级瞬时提示(「在浏览器中打开」失败时不再静默):6s 自动消失。
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => { setNotice(null) }, 6000)
    return () => { window.clearTimeout(timer) }
  }, [notice])

  const openSavedConnection = async (asset: RustAsset): Promise<void> => {
    try {
      await openAsset(asset)
      dismissConnectionChange()
    } catch (error) {
      setNotice(messages.workbenchOpenFailed(error instanceof Error ? error.message : String(error)))
    }
  }

  useEffect(() => { refreshAssets() }, [refreshAssets])

  const createConnection = (): void => {
    setSearch('')
    openConnectionManager(undefined, activeCategory?.initialConnectionKind)
  }
  const android = activeSubcategory === 'android'
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const groups = STARHUB_SUBCATEGORIES.filter(category => category.key !== 'android').map(category => {
    const connections = assets.filter(category.matches).map(asset => ({
      asset,
      badge: assetRowBadge(asset, asset.type === 'ssh' ? 'SSH' : category.label),
    }))
    const matches = connections.filter(({ asset, badge }) => {
      const fields = `${asset.name} ${assetSubtitle(asset)} ${badge} ${asset.type} ${category.label}`.toLowerCase()
      return terms.every(term => fields.includes(term))
    })
    return { category, connections, matches }
  })
  const total = groups.reduce((count, group) => count + group.connections.length, 0)
  const visibleGroups = groups.filter(({ category, matches }) =>
    matches.length > 0 && (activeCategory === undefined || activeCategory === category),
  )
  const visibleCount = visibleGroups.reduce((count, group) => count + group.matches.length, 0)
  const hasAssets = !preview && visibleCount > 0

  return (
    <div className={css.panel}>
      {execViewOpen ? (
        <ExecRecordList
          records={execRecords}
          onClose={closeTools}
          onClear={clearExecRecords}
          onDisconnect={disconnectExecSession}
        />
      ) : (
        <>
          <header className={css.header}>
            <h1 className={css.title}>{messages.toolsTitle}</h1>
            <div className={css.headerActions}>
              <button type="button" className={css.secondaryButton} onClick={openExecRecords}>{messages.sshExecRecords}</button>
              <button type="button" className={css.primaryButton} onClick={createConnection}>
                <IconPlusOutlineMedium size={15} />{messages.createConnection}
              </button>
            </div>
            <button
              type="button"
              className={clsx(css.iconButton, css.closeTools)}
              title={messages.returnToConversation}
              aria-label={messages.returnToConversation}
              onClick={closeTools}
            >
              <IconCloseOutlineMedium size={16} />
            </button>
          </header>
          <nav className={css.categories} aria-label={messages.connectionCategories}>
            <button type="button" className={css.category} aria-pressed={activeCategory === undefined} onClick={() => { selectSubcategory(null) }}>
              {messages.allConnections}
              {!preview && <span className={css.count}>{total}</span>}
            </button>
            {STARHUB_SUBCATEGORIES.map(category => {
              const size = groups.find(group => group.category === category)?.connections.length
              return (
                <button type="button" key={category.key} className={css.category} aria-pressed={activeCategory === category}
                  onClick={() => { selectSubcategory(category.key) }}>
                  <category.Icon size={14} />{category.label}
                  {!preview && size !== undefined && <span className={css.count}>{size}</span>}
                </button>
              )
            })}
          </nav>
          {!android && (
            <div className={css.searchBar}>
              <div className={css.searchField}>
                <IconSearchOutlineMedium size={16} />
                <input ref={searchRef} type="search" value={search} placeholder={messages.searchConnections} aria-label={messages.searchConnections}
                  onChange={event => { setSearch(event.target.value) }}
                  onKeyDown={event => { if (event.key === 'Escape') setSearch('') }} />
                {search !== '' && <button type="button" className={css.iconButton} aria-label={messages.clearConnectionSearch}
                  onClick={() => { setSearch(''); searchRef.current?.focus() }}><IconCloseOutlineMedium size={14} /></button>}
              </div>
              <button type="button" className={css.refreshButton} title={messages.refresh} aria-label={messages.refresh}
                disabled={loading} onClick={refreshAssets}>
                {loading ? <IconLoadingOutlineMedium className={css.spin} size={16} /> : <IconRefreshOutlineMedium size={16} />}
              </button>
            </div>
          )}
          {notice !== null && <div className={css.notice} role="status">{notice}</div>}
          {recentChange !== undefined && (
            <div className={css.connectionNotice}>
              <span className={css.connectionNoticeText} role="status">{changeMessages[recentChange.kind](recentChange.name)}</span>
              {createdAsset !== undefined && (
                <button type="button" className={css.secondaryButton} onClick={() => void openSavedConnection(createdAsset)}>
                  {messages.openSavedConnection}
                </button>
              )}
              <button type="button" className={css.iconButton} aria-label={messages.dismissConnectionNotice} onClick={dismissConnectionChange}>
                <IconCloseOutlineMedium size={13} />
              </button>
            </div>
          )}
          <div className={css.content}>
            {android ? <AndroidPanel /> : (
              <>
                {preview ? (
                  <div className={css.empty}>
                    <strong>{messages.previewMode}</strong>
                    <span>{messages.connectionPreviewHint}</span>
                  </div>
                ) : (
                  <>
                    {loading && !hasAssets && <div className={css.empty} role="status">
                      <IconLoadingOutlineMedium className={css.spin} size={20} />{messages.loadingConnections}
                    </div>}
                    {!loading && error !== null && <div className={css.errorBanner}>
                      <span role="alert">{messages.refreshConnectionsFailed(error)}</span>
                      <button type="button" className={css.secondaryButton} onClick={refreshAssets}>{messages.retry}</button>
                    </div>}
                    {hasAssets && visibleGroups.map(({ category, matches }) => (
                      <section className={css.group} key={category.key} aria-labelledby={`starhub-connections-${category.key}`}>
                        <div className={css.groupHeading}>
                          <h2 id={`starhub-connections-${category.key}`}>{category.label}</h2>
                          {terms.length > 0 && <span>{messages.connectionCount(matches.length)}</span>}
                        </div>
                        <ul className={css.list}>
                          {matches.map(({ asset, badge }) => (
                            <AssetRow key={asset.id} asset={asset} badgeLabel={badge}
                              active={(createdAsset?.id ?? activeAssetId) === asset.id}
                              onOpenInPage={() => openAsset(asset)}
                              onReference={() => { insertAssetReference(asset) }}
                              onEdit={() => { openConnectionManager(asset) }}
                              onNotice={setNotice} />
                          ))}
                        </ul>
                      </section>
                    ))}
                    {!loading && (error === null || total > 0) && !hasAssets && (
                      <div className={css.empty} role="status">
                        <IconSearchOutlineMedium size={23} />
                        <strong>{terms.length > 0 ? messages.noConnectionMatches
                          : activeCategory === undefined ? messages.noConnections : messages.noCategoryConnections(activeCategory.label)}</strong>
                        {terms.length === 0 && <button type="button" className={css.secondaryButton} onClick={createConnection}>
                          {messages.createConnection}
                        </button>}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
