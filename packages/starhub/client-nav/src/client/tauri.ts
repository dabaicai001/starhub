/**
 * StarHub client-nav 的宿主桥 IPC seam(去 Tauri 化 M2)。
 *
 * 桌面端不再是 Tauri 壳:React 工作台由 `starhub-bridge` 插件经同源 HTTP
 * 服务暴露同一套命令面——
 * - `POST /starhub/api/invoke`,body `{cmd, args}`,返回
 *   `{ok:true,result}` / `{ok:false,error}`(bridge 把 cmd 加成 `ui.<cmd>`
 *   前缀打给 sidecar);
 * - `GET /starhub/api/events` 是 SSE 流,每条通知以原始事件名作 SSE
 *   `event:` 字段,`data:` 是 JSON。
 *
 * 本文件是这一切换点,导出名与签名一个都没改,所以工作台全部 113 个调用点
 * 零改动:浏览器预览(无宿主可达)时 invoke reject、listen 退化为 no-op,
 * 与旧 Tauri internals 缺失时的降级语义一致。
 */

/** `POST /starhub/api/invoke` 的响应信封(bridge 插件契约)。 */
type InvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/** invoke 端点(同源,由 starhub-bridge 插件挂载)。 */
const INVOKE_URL = '/starhub/api/invoke'

/** SSE 事件流端点(同源;每条通知的 SSE event 字段即原始事件名)。 */
const EVENTS_URL = '/starhub/api/events'

/**
 * 调一条宿主桥命令(旧 Tauri IPC 的替换,签名不变)。
 * @param cmd - 命令名(bridge 会加 `ui.` 前缀打给 sidecar)。
 * @param args - 命令参数(camelCase 键);缺省时请求体不带 args 键。
 * @param signal - 放弃等待 HTTP 响应；sidecar 可能仍在处理命令。
 * @returns 命令结果。
 * @throws 响应为 `{ok:false,error}` 时以 error 消息 reject;非 2xx 响应
 *   (宿主桥未挂载/路由不存在)reject `host bridge unavailable (status)`。
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(INVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`host bridge unavailable (${response.status})`)
  }
  const body = await response.json() as InvokeResponse
  if (!body.ok) throw new Error(body.error)
  return body.result as T
}

interface HostEventSubscription {
  handlers: Set<(payload: unknown) => void>
  listener: EventListener
}

const hostEventSubscriptions = new Map<string, HostEventSubscription>()
let hostEventSource: EventSource | null = null
let hostEventRetry: ReturnType<typeof setTimeout> | undefined

/** Reopen a closed stream with all live subscriptions. EventSource handles transient errors. */
function ensureHostEventSource(): void {
  if (typeof EventSource === 'undefined' || hostEventSubscriptions.size === 0) return
  if (hostEventSource !== null && hostEventSource.readyState !== EventSource.CLOSED) return
  clearTimeout(hostEventRetry)
  hostEventRetry = undefined
  for (const [event, { listener }] of hostEventSubscriptions) hostEventSource?.removeEventListener(event, listener)
  const source = new EventSource(EVENTS_URL, { withCredentials: true })
  hostEventSource = source
  for (const [event, { listener }] of hostEventSubscriptions) source.addEventListener(event, listener)
  source.addEventListener('error', () => {
    if (source !== hostEventSource || source.readyState !== EventSource.CLOSED || hostEventRetry !== undefined) return
    hostEventRetry = setTimeout(ensureHostEventSource, 1_000)
  })
}

/** Async disposer returned by an event subscription. */
export type TauriUnlisten = () => Promise<void>

/** Subscribe to a sidecar event on this document's shared SSE connection. */
// eslint-disable-next-line typescript/no-unnecessary-type-parameters
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<TauriUnlisten> {
  if (typeof EventSource === 'undefined') return () => Promise.resolve()
  let subscription = hostEventSubscriptions.get(event)
  if (subscription === undefined) {
    const handlers = new Set<(payload: unknown) => void>()
    const listener: EventListener = (raw): void => {
      let payload: unknown
      try {
        payload = JSON.parse((raw as MessageEvent<string>).data)
      } catch {
        return
      }
      for (const current of handlers) current(payload)
    }
    subscription = { handlers, listener }
    hostEventSubscriptions.set(event, subscription)
    hostEventSource?.addEventListener(event, listener)
  }
  const { handlers, listener } = subscription
  const wrapped = (payload: unknown): void => { handler(payload as T) }
  handlers.add(wrapped)
  ensureHostEventSource()

  return async () => {
    if (!handlers.delete(wrapped) || handlers.size !== 0) return
    hostEventSubscriptions.delete(event)
    hostEventSource?.removeEventListener(event, listener)
    if (hostEventSubscriptions.size === 0) {
      clearTimeout(hostEventRetry)
      hostEventRetry = undefined
      const source = hostEventSource
      hostEventSource = null
      source?.close()
    }
  }
}

/**
 * Window-label prefix for one keyed StarHub page (`starhub-page-<key>-`).
 * The key (asset id for asset pages) lets a focus request identify an
 * already-opened page; kept for call-site compatibility after the Tauri
 * webview windows retired.
 * @param key - stable page identity (e.g. the asset id).
 * @returns the label prefix; the full label appends a timestamp.
 */
export function starhubPageLabelPrefix(key: string): string {
  return `starhub-page-${key}-`
}

/**
 * 壳内工作台页宿主(去 Tauri 化 M2 第 6 步):装了宿主就把「开新窗口」改为
 * 「开主壳内的面板页」(见 `workbench-panel.ts` / `StarHubWorkbenchPanel.tsx`);
 * 没装(浏览器预览 / 单测)时保持 `window.open` 的老行为。
 * 由 client-nav 的 apply 经 `installWorkbenchPageHost` 安装、`ctx.effect`
 * 卸载时摘除(HMR 安全)。
 */
export type WorkbenchPageHost = (path: string, title: string, key: string) => void

let workbenchPageHost: WorkbenchPageHost | null = null

/**
 * Install (or clear) the in-shell workbench page host.
 * @param host - the host that opens a panel page; null restores the
 *   `window.open` fallback (preview / tests).
 */
export function installWorkbenchPageHost(host: WorkbenchPageHost | null): void {
  workbenchPageHost = host
}

/**
 * Open a StarHub page: in the dsh desktop shell the standalone React
 * workbench lives in an in-shell main panel (one tab per asset instance), so
 * the installed host opens/activates a panel page instead of a new window.
 * Without a host (browser preview) it falls back to a same-origin new tab.
 * @param path - same-origin page path (absolute path, not full URL).
 * @param title - page title (asset name; the panel tab label).
 * @param key - stable page identity (asset id); an already-open key focuses
 *   the existing page instead of opening a second one.
 * @returns after the page has been opened (or focused).
 * @throws when no host is installed and window.open is intercepted (popup
 *   blocked) — a failed open must surface, not quietly do nothing.
 */
export async function openNewPage(path: string, title = '', key = ''): Promise<void> {
  if (workbenchPageHost !== null) {
    workbenchPageHost(path, title, key)
    return
  }
  const opened = window.open(new URL(path, window.location.origin), '_blank', 'noopener')
  if (opened === null) {
    throw new Error('window.open intercepted (popup blocked)')
  }
}

/**
 * Focus an already-opened keyed StarHub page, best-effort: broadcasts the
 * page key on the same-origin `starhub-focus` channel, where the opened
 * page raises itself. Any failure (no BroadcastChannel, broadcast error)
 * reports false so the caller falls back to opening the page.
 * @param key - the page identity embedded at open time (asset id).
 * @returns true when the focus broadcast was posted; false in preview, or
 *   when the broadcast fails.
 */
export async function focusWindowByKey(key: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return false
  try {
    const channel = new BroadcastChannel('starhub-focus')
    channel.postMessage({ key })
    channel.close()
    return true
  } catch {
    // 广播失败(如通道被占用):按「无可聚焦页面」处理,由调用方回退打开页面。
    return false
  }
}

/**
 * Whether a host bridge is reachable (the de-Tauri replacement for the old
 * `__TAURI_INTERNALS__` presence check): the workbench always runs inside a
 * browser-like realm with fetch, so this reports whether the host bridge
 * HTTP surface can be reached at all.
 * @returns true when running inside a host with fetch available.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && typeof fetch === 'function'
}
