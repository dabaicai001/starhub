/**
 * Workbench API: the HTTP/SSE seat that replaces the Tauri IPC bridge for the
 * standalone React workbench (去 Tauri 化 M1;StarHub-local package).
 *
 * The React workbench (`apps/starhub-window`, served by `starhub-host-static`
 * under `/starhub-react/`) used to call `window.__TAURI_INTERNALS__.invoke`
 * and listen on Tauri events. In the standalone composition there is no Tauri
 * shell, so the same two faces ride the bridge's own routes:
 *
 * - `POST /starhub/api/invoke` `{cmd, args}` → `{ok:true,result}` /
 *   `{ok:false,error}`; `cmd` is a sidecar method name (the Tauri command
 *   names mirror the sidecar method names for the domains that moved).
 * - `GET /starhub/api/events` — Server-Sent Events stream carrying every
 *   sidecar notification under its original event name (`ssh:exec-done`,
 *   `sftp://transfer-progress`, `starhub://open-asset`, …), so a workbench
 *   listener keeps the event names it already uses.
 *
 * Both routes are same-origin under the dsh web server (loopback +
 * trustedHosts policy), so the workbench reuses the host page's session
 * without extra authorization plumbing. Commands the sidecar does not
 * implement answer `{ok:false,error}` — the workbench renders its
 * preview/error state, the same degradation a missing Tauri IPC produced.
 *
 * @module @deepseek-ai/dsh-starhub-bridge/workbench
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** Route prefix for the workbench API (distinct from the `/starhub-react` assets). */
export const WORKBENCH_API_PREFIX = '/starhub/api'

/** Exact route for a command invocation. */
export const INVOKE_ROUTE = `${WORKBENCH_API_PREFIX}/invoke`

/** Exact route for the Server-Sent Events stream. */
export const EVENTS_ROUTE = `${WORKBENCH_API_PREFIX}/events`

/**
 * Method prefix for the sidecar's UI plane (M2).
 *
 * The workbench speaks the retired Tauri command names; the sidecar registers
 * them under `ui.<command>` so the UI plane can never collide with the model
 * tool surface (same resource, different parameters — e.g. `sftp_list`).
 */
export const UI_METHOD_PREFIX = 'ui.'

/** Map one workbench command name to its sidecar method. */
export function uiMethod(cmd: string): string {
  return `${UI_METHOD_PREFIX}${cmd}`
}

/**
 * 桥内命令(不下发 sidecar):问「宿主源」。
 *
 * 桌面壳里 GUI 文档的 origin 是 `dsh-app://app/`(壳用 `protocol.handle` 把
 * `dsh-app://app/<path>` 反代到真正的宿主),前端因此**拿不到**宿主的
 * `http://127.0.0.1:<port>`;而「把工作台相对路径交给系统浏览器」必须用宿主
 * 绝对 URL。这里用请求的 Host 头还原宿主源,由见过请求的宿主侧给出答案。
 */
export const HOST_ORIGIN_COMMAND = 'host_origin'

/** 合法的 Host 头形态(`host` / `host:port`);挡掉空白、斜杠等拼接材料。 */
const HOST_HEADER = /^[A-Za-z0-9.-]+(:\d{1,5})?$/

/**
 * 由请求头还原宿主源;还原不出返回 null。
 * @param req - 入站工作台请求。
 * @returns 形如 `http://127.0.0.1:19387` 的源,或 null(无/非法 Host)。
 */
function hostOriginOf(req: IncomingMessage): string | null {
  const host = req.headers.host
  if (typeof host !== 'string' || !HOST_HEADER.test(host)) return null
  const forwarded = req.headers['x-forwarded-proto']
  const proto = forwarded === 'https' ? 'https' : 'http'
  return `${proto}://${host}`
}

/** Maximum accepted request body for one invocation (bytes). */
const MAX_INVOKE_BODY_BYTES = 1024 * 1024

/** Default budget for one workbench invocation (10 minutes). */
export const DEFAULT_INVOKE_TIMEOUT_MS = 10 * 60_000

/** Hard ceiling for a caller-supplied budget (2 hours). */
export const MAX_INVOKE_TIMEOUT_MS = 2 * 60 * 60_000

/** Extra slack on top of a command's own `timeoutSec` before the HTTP budget expires. */
const INVOKE_TIMEOUT_SLACK_MS = 15_000

/** Per-route knobs: the default budget and the caller's ceiling. */
export interface InvokeHandlerOptions {
  /** Budget when neither `timeoutMs` nor `args.timeoutSec` names one. */
  timeoutMs?: number
  /** Upper bound for any single invocation. */
  maxTimeoutMs?: number
}

/**
 * Resolve one invocation's wall-clock budget.
 *
 * A command that carries its own `timeoutSec` (SSH exec, monitoring probes) gets
 * that budget plus slack, so the HTTP layer never cuts a job the sidecar was
 * told to run longer; otherwise the route default applies.
 * @param body - decoded request body.
 * @param args - sidecar params.
 * @param options - route defaults.
 * @returns budget in milliseconds, clamped to [1s, maxTimeoutMs].
 */
export function resolveInvokeBudget(
  body: Record<string, unknown>,
  args: Record<string, unknown>,
  options: InvokeHandlerOptions = {},
): number {
  const max = options.maxTimeoutMs ?? MAX_INVOKE_TIMEOUT_MS
  const requested = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
    ? body.timeoutMs
    : undefined
  const commandSec = typeof args.timeoutSec === 'number' && Number.isFinite(args.timeoutSec)
    ? args.timeoutSec
    : undefined
  const derived = commandSec === undefined ? undefined : commandSec * 1000 + INVOKE_TIMEOUT_SLACK_MS
  const budget = requested ?? derived ?? options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS
  return Math.min(Math.max(budget, 1_000), max)
}

/**
 * Race one sidecar request against the invocation budget.
 * @param pending - the in-flight sidecar request.
 * @param timeoutMs - wall-clock budget.
 * @param label - command name used in the failure message.
 * @returns the sidecar result.
 * @throws Error naming the command and budget when the budget expires.
 */
async function withBudget<T>(pending: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = timeoutMs < 1_000 ? `${String(Math.round(timeoutMs))}ms` : `${String(Math.round(timeoutMs / 1000))}s`
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `${label} 超过 ${budget} 未返回:sidecar 仍在执行或已失联。`
            + '长耗时命令请显式传 timeoutSec(秒)或 timeoutMs(毫秒)。',
          ))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Read and JSON-parse a bounded request body; rejects on oversize or bad JSON. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_INVOKE_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Write one JSON response and end it. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Build the `POST /starhub/api/invoke` handler.
 *
 * Every invocation is bounded: an unanswered sidecar request would otherwise
 * leave the workbench on a perpetual spinner. The budget comes from the caller
 * (`timeoutMs`), the command's own `timeoutSec`, or the route default. If the
 * request carries an `execId`, expiring it also asks the sidecar to abort that
 * execution. A client that disconnects first gets no response written.
 *
 * @param sidecar - live sidecar transport.
 * @param options - default and maximum budget.
 * @returns the node:http request handler.
 */
export function invokeHandler(
  sidecar: JsonRpcTransportPeer,
  options: InvokeHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : ''
    if (cmd === '') {
      sendJson(res, 400, { ok: false, error: 'cmd is required' })
      return
    }
    const args = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as object
    if (cmd === HOST_ORIGIN_COMMAND) {
      const origin = hostOriginOf(req)
      if (origin === null) {
        sendJson(res, 200, { ok: false, error: 'host origin unavailable (missing Host header)' })
        return
      }
      sendJson(res, 200, { ok: true, result: { origin } })
      return
    }
    // 客户端先断(关页签 / 切资产):请求已经发出,不在超时或失败时再写响应。
    // 用对象承载标记,避免 TS 把这个只由回调赋值的 let 窄化成字面量 false。
    const connection = { gone: false }
    const onGone = (): void => { connection.gone = true }
    req.on('close', onGone)
    const record = args as Record<string, unknown>
    const execId = typeof record.execId === 'string' ? record.execId : ''
    const budget = resolveInvokeBudget(body, record, options)
    try {
      const result = await withBudget(sidecar.request(uiMethod(cmd), args), budget, cmd)
      if (!connection.gone) sendJson(res, 200, { ok: true, result })
    } catch (error) {
      // 超时/断连:若这条调用带执行身份,顺手让 sidecar 停掉它,别让"界面以为失败、
      // 服务器还在跑"成为常态。
      if (execId !== '') sidecar.notify('starhub/exec.abort', { execId })
      // 未实现的命令 / sidecar 报错:软错误给工作台(与 Tauri IPC 缺失同款降级)。
      if (!connection.gone) sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      req.off('close', onGone)
    }
  }
}

/** One connected SSE client. */
interface EventClient {
  readonly write: (frame: string) => void
  readonly close: () => void
}

/**
 * Build the `GET /starhub/api/events` SSE handler.
 *
 * The handler owns the response for the connection's lifetime: it registers a
 * broadcaster on the dispatcher, emits a comment on connect (so proxies flush
 * headers), and unregisters on close.
 *
 * @param subscribe - subscribes one broadcaster to every sidecar notification
 *   (the dispatcher's `attach` seam) and returns its disposer.
 * @returns the node:http request handler.
 */
export function eventsHandler(
  subscribe: (broadcast: (event: string, payload: unknown) => void) => () => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': starhub bridge connected\n\n')
    const client: EventClient = {
      write: (frame: string) => {
        if (!res.writableEnded) res.write(frame)
      },
      close: () => {
        if (!res.writableEnded) res.end()
      },
    }
    const dispose = subscribe((event: string, payload: unknown) => {
      const data = JSON.stringify(payload ?? {})
      // 事件名原样透传(工作台监听的名字不变);data 单行 JSON。
      client.write(`event: ${event}\ndata: ${data}\n\n`)
    })
    const onClose = (): void => {
      dispose()
      client.close()
    }
    req.on('close', onClose)
    res.on('close', onClose)
  }
}
