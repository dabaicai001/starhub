/**
 * StarHub 工作台主面板(去 Tauri 化 M2 第 6 步「iframe 搬入」)。
 *
 * 资产实例操作页不再是独立 webview 窗口 / 新标签页,而是本面板内的一个标签页:
 * 标签条一页一签(点签切换、× 关页),内容区用**同源 iframe** 承载
 * `/starhub-react/` 独立程序。iframe 与主壳同源,因此工作台内的
 * `tauriInvoke` / `tauriListen` 经同一套宿主桥(fetch + SSE)打到 sidecar,
 * 113 个调用点零改动。
 *
 * v0.140.4 起**一页一个常驻 iframe**(非活动页 visibility:hidden):此前单个
 * iframe 换 `src` 会触发整页导航,切回资产时工作台里的查询标签、滚动位置、
 * 连接与未保存草稿全部重来。
 *
 * 独立主面板用于没有会话或右侧栏服务的情况,挂在 `main` keyed 槽。
 * 右侧栏由 DSH 管理标签与关闭交互,两种布局共用 iframe 渲染。
 *
 * 标签交互:v0.141.0 起方向键 / Home / End 在标签间移动并同步激活,
 * 关闭钮常显但降低不透明度;中键单击标签也可关页。
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'main' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutlineMedium, IconLoadingOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { interactionMessages } from './interaction-messages.ts'
import { embeddedWorkbenchUrl, type WorkbenchPanelState } from './workbench-panel.ts'
import { listenForTerminalReference } from './terminal/reference.ts'
import css from './StarHubWorkbenchPanel.module.css'

/** Business face injected by the registration: page writes + the page store. */
export interface StarHubWorkbenchPanelInjected {
  /** 激活一页(点标签)。 */
  activatePage: (key: string) => void
  /** 关一页(标签上的 ×);关掉最后一页 = 面板让回会话视图(index.ts 订阅)。 */
  closePage: (key: string) => void
  /** 无页时的兜底出口:把主面板让回会话视图。 */
  closeWorkbench: () => void
  referenceTerminal?: TerminalReference | undefined
  hooks: {
    /** 页簿(裸 source,渲染器绑定为 useWorkbench)。 */
    workbench: SnapshotStore<WorkbenchPanelState>
  }
}

/** Full composed props: main-panel runtime share + the injected face. */
export type StarHubWorkbenchPanelProps =
  & PropsRuntime<'main'>
  & InjectFace<StarHubWorkbenchPanelInjected>

/** Keep loaded pages mounted and show feedback while the active frame navigates. */
export type TerminalReference = (assetId: string, terminalSessionId: string) => Promise<void>

function WorkbenchFrame({ assetId, title, url, index, active = true, referenceTerminal }: {
  assetId: string
  title: string
  url: string
  index?: number
  active?: boolean
  referenceTerminal?: TerminalReference | undefined
}) {
  const [loaded, setLoaded] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (frame.current === null || referenceTerminal === undefined) return
    return listenForTerminalReference(frame.current, assetId, referenceTerminal)
  }, [assetId, referenceTerminal])
  return (
    <>
      <iframe
        ref={frame}
        id={index === undefined ? undefined : `starhub-panel-${index}`}
        aria-labelledby={index === undefined ? undefined : `starhub-tab-${index}`}
        role={index === undefined ? undefined : 'tabpanel'}
        className={clsx(css.frame, !active && css.frameHidden)}
        title={title}
        src={url}
        allow="clipboard-read; clipboard-write; fullscreen"
        aria-hidden={active ? undefined : true}
        tabIndex={active ? 0 : -1}
        onLoad={() => { setLoaded(true) }}
      />
      {active && !loaded && (
        <div className={css.frameLoading} role="status">
          <IconLoadingOutlineMedium size={16} className={css.spin} />
          {interactionMessages().loadingWorkbench}
        </div>
      )}
    </>
  )
}

/** Render one asset inside a native DSH right-sidebar tab. */
export function StarHubSidebarWorkbench({ assetId, title, referenceTerminal }: {
  assetId: string
  title: string
  referenceTerminal: TerminalReference
}) {
  // Keep the iframe URL stable when the host theme changes. Open pages update
  // their theme through the existing BroadcastChannel.
  const [url] = useState(() => embeddedWorkbenchUrl(`/starhub-react/index.html?${new URLSearchParams({ asset: assetId })}`))
  return (
    <div className={css.panel}>
      <div className={css.frameStack}>
        <WorkbenchFrame assetId={assetId} title={title} url={url} referenceTerminal={referenceTerminal} />
      </div>
    </div>
  )
}

/**
 * Render the in-shell workbench: tab strip over a same-origin iframe.
 * @param props - main-panel runtime share + injected page writes/store.
 * @returns the panel element, or an empty-state fallback when no page is open.
 */
export function StarHubWorkbenchPanel({
  useWorkbench,
  activatePage,
  closePage,
  closeWorkbench,
  referenceTerminal,
}: StarHubWorkbenchPanelProps): JSX.Element {
  const state = useWorkbench((snapshot) => snapshot)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const active = state.pages.find((page) => page.key === state.activeKey)
    ?? state.pages[state.pages.length - 1]

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (active === undefined) return
    const keys = state.pages.map((page) => page.key)
    const current = keys.indexOf(active.key)
    let next: string | undefined
    switch (event.key) {
      case 'ArrowRight':
        next = keys[(current + 1) % keys.length]
        break
      case 'ArrowLeft':
        next = keys[(current - 1 + keys.length) % keys.length]
        break
      case 'Home':
        next = keys[0]
        break
      case 'End':
        next = keys[keys.length - 1]
        break
      default:
        return
    }
    if (next === undefined) return
    event.preventDefault()
    activatePage(next)
    tabRefs.current.get(next)?.focus()
  }

  if (active === undefined) {
    return (
      <div className={css.panel}>
        <div className={css.empty} role="status">
          <span className={css.emptyTitle}>没有打开的工作台页面</span>
          <span className={css.emptyHint}>从「StarHub 工具」里打开一个资产,或返回会话。</span>
          <button type="button" className={css.emptyAction} onClick={closeWorkbench}>返回会话</button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.panel}>
      <div
        className={css.tabs}
        role="tablist"
        aria-label="StarHub 工作台"
        onKeyDown={moveFocus}
      >
        {state.pages.map((page, index) => {
          const isActive = page.key === active.key
          return (
            <span key={page.key} className={clsx(css.tabSlot, isActive && css.tabSlotActive)}>
              <button
                type="button"
                role="tab"
                id={`starhub-tab-${index}`}
                aria-selected={isActive}
                aria-controls={`starhub-panel-${index}`}
                tabIndex={isActive ? 0 : -1}
                ref={(element) => {
                  if (element === null) tabRefs.current.delete(page.key)
                  else tabRefs.current.set(page.key, element)
                }}
                className={clsx(css.tab, isActive && css.active)}
                onClick={() => { activatePage(page.key) }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  closePage(page.key)
                }}
              >
                <span className={css.tabLabel}>{page.title}</span>
              </button>
              <button
                type="button"
                aria-label={`关闭 ${page.title}`}
                title={`关闭 ${page.title}`}
                tabIndex={isActive ? 0 : -1}
                className={css.tabClose}
                onClick={() => { closePage(page.key) }}
              >
                <IconCloseOutlineMedium size={12} />
              </button>
            </span>
          )
        })}
      </div>
      <div className={css.frameStack}>
        {/* 一页一个常驻 iframe:切标签只改可见性。此前是单个 iframe 改 src,
            Chromium 会重新导航 —— 页面内查询标签、滚动、连接与草稿整页重来。 */}
        {state.pages.map((page, index) => (
          <WorkbenchFrame key={`${page.key}:${page.url}`} assetId={page.key} title={page.title} url={page.url}
            index={index} active={page.key === active.key} referenceTerminal={referenceTerminal} />
        ))}
      </div>
    </div>
  )
}
