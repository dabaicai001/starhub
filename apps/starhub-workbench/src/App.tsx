/**
 * Workbench entry: resolve the asset through the host bridge and render its
 * React workspace in the system browser or a tab in the DSH shell.
 * Reuses the client-nav workbench components so SSH/SFTP sharing, DB
 * lifecycle, Docker and Redis panels all behave identically to the in-shell
 * versions.
 */
import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { interactionMessages } from '@deepseek-ai/dsh-starhub-client-nav/src/client/interaction-messages.ts'
import { loadStarHubAsset, type RustAsset } from '@deepseek-ai/dsh-starhub-client-nav/src/client/store.ts'
import { reportWorkbenchLoaded, useWorkbenchActivity } from '@deepseek-ai/dsh-starhub-client-nav/src/client/workbench-activity.ts'
import {
  parseWindowParams, workbenchForAsset, workbenchForRouteName, type WindowWorkbench,
} from './route.ts'

const DbWorkbench = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/DbWorkbench.tsx').then(m => ({ default: m.DbWorkbench })))
const DockerWorkbench = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/docker/DockerWorkbench.tsx').then(m => ({ default: m.DockerWorkbench })))
const RedisWorkbench = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/redis/RedisWorkbench.tsx').then(m => ({ default: m.RedisWorkbench })))
const ElasticsearchWorkbench = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/es/ElasticsearchWorkbench.tsx').then(m => ({ default: m.ElasticsearchWorkbench })))
const BrokerView = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/broker/BrokerView.tsx').then(m => ({ default: m.BrokerView })))
const SshTerminalOverlay = lazy(() => import('@deepseek-ai/dsh-starhub-client-nav/src/client/terminal/SshTerminalOverlay.tsx').then(m => ({ default: m.SshTerminalOverlay })))

/** Shell states: loading, resolved to a workbench, or failed. */
type ShellState =
  | { kind: 'loading' }
  | { kind: 'no-params' }
  | { kind: 'load-failed'; message: string }
  | { kind: 'asset-missing'; assetId: string }
  | { kind: 'unsupported'; assetId: string }
  | { kind: 'ready'; asset: RustAsset; workbench: WindowWorkbench }

/** Surface a workbench render failure instead of leaving an empty webview. */
class WorkbenchErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('StarHub workbench render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <WorkbenchFailure title={interactionMessages().workbenchLoadFailed} detail={this.state.error.message} onRetry={this.props.onRetry} />
    }
    return this.props.children
  }
}

function WorkbenchLoading({ title }: { title: string }) {
  return (
    <div className="window-status" role="status">
      <span className="window-spinner" aria-hidden="true" />
      <p>{title}</p>
    </div>
  )
}

function WorkbenchFailure({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="window-status">
      <div className="window-error-card">
        <div role="alert">
          <p className="window-error-title">{title}</p>
          {detail !== undefined && <p className="window-error-detail">{detail}</p>}
        </div>
        {onRetry !== undefined && <button type="button" onClick={onRetry}>{interactionMessages().retry}</button>}
      </div>
    </div>
  )
}

/** Workbench actions use the containing browser window when opened as a popup. */
function requestWindowClose(): void {
  if (window.parent === window) window.close()
}

/** Standalone shell: resolve the URL to a workbench and render it. */
export function WindowShell() {
  const [state, setState] = useState<ShellState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const active = useWorkbenchActivity()
  const messages = interactionMessages()
  const retry = () => {
    setState({ kind: 'loading' })
    setAttempt(previous => previous + 1)
  }
  // 壳内 iframe 与独立浏览器页共用同一入口:embed=1 时去掉整页窗口感
  // (SSH 的遮罩/16px 边距),由主壳标签条承担 chrome。
  const embedded = new URLSearchParams(window.location.search).get('embed') === '1'

  useEffect(() => {
    const params = parseWindowParams(window.location.search)
    if (params === null) {
      setState({ kind: 'no-params' })
      return
    }
    const request = new AbortController()
    loadStarHubAsset(params.assetId, request.signal)
      .then((asset) => {
        if (request.signal.aborted) return
        if (asset === undefined) {
          setState({ kind: 'asset-missing', assetId: params.assetId })
          return
        }
        const workbench = params.workbench ?? workbenchForAsset(asset)
        if (workbench === null) {
          setState({ kind: 'unsupported', assetId: params.assetId })
          return
        }
        setState({ kind: 'ready', asset, workbench })
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          setState({ kind: 'load-failed', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => { request.abort() }
  }, [attempt])

  const renderWorkbench = (asset: RustAsset, workbench: WindowWorkbench) => {
    switch (workbench) {
      case 'ssh':
        return <SshTerminalOverlay asset={asset} onClose={requestWindowClose} page embedded={embedded} active={active} />
      case 'db-mysql':
      case 'db-postgresql':
      case 'db-clickhouse':
      case 'db-sqlite':
      case 'db-mssql':
        return <DbWorkbench asset={asset} embedded={embedded} {...(embedded ? {} : { onClose: requestWindowClose })} />
      case 'db-redis':
        return <RedisWorkbench asset={asset} />
      case 'db-elasticsearch':
        return <ElasticsearchWorkbench asset={asset} />
      case 'broker':
        return <BrokerView asset={asset} active={active} />
      case 'docker':
        return <DockerWorkbench asset={asset} />
    }
  }

  if (state.kind === 'ready') {
    return (
      <div className={`window-frame standalone-workbench${embedded ? ' embedded-workbench' : ''}`}>
        <WorkbenchErrorBoundary onRetry={() => { window.location.reload() }}>
          <Suspense fallback={<WorkbenchLoading title={messages.preparingWorkbench(state.asset.name)} />}>
            {renderWorkbench(state.asset, state.workbench)}
          </Suspense>
        </WorkbenchErrorBoundary>
      </div>
    )
  }

  switch (state.kind) {
    case 'loading':
      return <WorkbenchLoading title={messages.loadingWorkbench} />
    case 'load-failed':
      return <WorkbenchFailure title={messages.workbenchLoadFailed} detail={state.message} onRetry={retry} />
    case 'no-params':
      return <WorkbenchFailure title={messages.noAssetParameter} />
    case 'asset-missing':
      return <WorkbenchFailure title={messages.missingAsset(state.assetId)} onRetry={retry} />
    case 'unsupported':
      return <WorkbenchFailure title={messages.unsupportedAsset(state.assetId)} />
  }
}

/** Keep a reference so HMR can unmount cleanly (used by main.tsx). */
export let rootRef: Root | null = null
/** Same-origin channel the DSH shell uses to broadcast theme flips. */
let themeChannel: BroadcastChannel | null = null
export function render(container: HTMLElement): void {
  rootRef = createRoot(container)
  rootRef.render(<WindowShell />)
}

/** Resolve the workbench-window theme from the opener's `dark` hint, else fall
 *  back to DSH's default preference (`system` → `prefers-color-scheme`). The
 *  standalone workbench has no ui-theme plugin tree, so it mirrors the shell's
 *  resolved theme instead of pinning a fixed palette. */
export function resolveWindowTheme(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const dark = params.get('dark')
  if (dark !== null) return dark === '1'
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Convenience used by tests/main: mount into #root. */
export function mount(): void {
  const apply = (dark: boolean): void => {
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  }
  const params = new URLSearchParams(window.location.search)
  const fromHint = params.get('dark') !== null
  // 跟随宿主(DSH 壳)的解析主题:opener 传 `dark` 命中则用,否则按 system 解析;
  // 独立窗口不跑 dsh 插件树(ui-theme),故按此显式落地 DSH 的深浅色 token 切换。
  apply(resolveWindowTheme(window.location.search))
  // system 模式(无显式 dark 提示)下跟随操作系统深色切换实时更新。
  if (!fromHint && typeof matchMedia !== 'undefined') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => { apply(mq.matches) })
  }
  // 页面打开后 DSH 再切深浅色:经同源 BroadcastChannel 接收壳的广播,
  // 已打开的工作台不再停留在旧主题。
  themeChannel?.close()
  themeChannel = null
  if (typeof BroadcastChannel !== 'undefined') {
    themeChannel = new BroadcastChannel('starhub-theme')
    themeChannel.addEventListener('message', (event) => {
      const dark = (event.data as { dark?: unknown } | null)?.dark
      if (typeof dark === 'boolean') apply(dark)
    })
  }
  const el = document.getElementById('root')
  if (el !== null) {
    render(el)
    reportWorkbenchLoaded()
  }
}

// Expose workbenchForRouteName for external/route reuse without an asset.
export { workbenchForRouteName }
