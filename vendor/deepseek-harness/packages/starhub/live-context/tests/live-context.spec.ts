/**
 * StarHub live context(契约 §2.2/§5,M3):渲染、截断、pull 降级、pre-step 注入。
 * v0.140.3:AI 起源内容按发起会话 id 做会话级过滤(composeLiveContext 的
 * `sessionId` 参数),只放行当前 agent 会话自己产生的执行。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionRegistry } from '@deepseek-ai/dsh-starhub-session-registry'
import { DomainEventStore } from '@deepseek-ai/dsh-starhub-domain-events'
import { apply, composeLiveContext, truncateText } from '../src/index.ts'

/** 当前 agent 会话 id(过滤基准)。 */
const OWN_SESSION = 'own-session'
/** 别的会话(主壳 / 其它终端页助手)发起的执行,不许注入。 */
const OTHER_SESSION = 'other-session'

type PreStepListener = (
  payload: { agent: { session: { id: string } }; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

/** pre-step payload 的agent 面(测试直传)。 */
function preStepPayload(signal: AbortSignal, sessionId = OWN_SESSION) {
  return { agent: { session: { id: sessionId } }, signal }
}

function makeTransport(result: unknown): {
  request: ReturnType<typeof vi.fn>
  transport: JsonRpcTransportPeer
} {
  const request = vi.fn(async () => (
    typeof result === 'function' ? (result as () => Promise<unknown>)() : result
  ))
  return { request, transport: { request } as unknown as JsonRpcTransportPeer }
}

function makeCtx(services: Record<string, unknown>) {
  const listeners: PreStepListener[] = []
  const on = vi.fn((_event: string, listener: PreStepListener) => {
    listeners.push(listener)
    return () => undefined
  })
  const effect = vi.fn((callback: () => (() => void) | undefined) => callback())
  const ctx = {
    get: (serviceName: string) => services[serviceName],
    on,
    effect,
  } as unknown as Context
  return { ctx, listeners, on, effect }
}

function seedRegistry(): SessionRegistry {
  const registry = new SessionRegistry()
  registry.replace({
    sessions: [
      { assetId: 'a1', sessionId: 's1', kind: 'ssh', attachedBy: ['shell'] },
      { assetId: 'a2', sessionId: 's2', kind: 'db', attachedBy: [] },
    ],
  })
  return registry
}

function seedEvents(): DomainEventStore {
  const store = new DomainEventStore()
  store.push({ kind: 'ssh.exec_completed', assetId: 'a1', ts: 100, summary: 'ran ls' })
  // AI 起源事件带发起会话:只有等于当前会话的才注入(v0.140.3)。
  store.push({ kind: 'db.query_executed', assetId: 'a2', ts: 90, summary: 'select count', origin: 'ai', sessionId: OWN_SESSION })
  store.push({ kind: 'db.query_executed', assetId: 'a2', ts: 85, summary: 'other session query', origin: 'ai', sessionId: OTHER_SESSION })
  store.push({ kind: 'session.attached', ts: 80, summary: 'shell attached' })
  return store
}

const SNAPSHOT = {
  sessions: [],
  transfers: [
    { id: 't1', assetId: 'a1', direction: 'upload', bytes: 512, totalBytes: 1024, state: 'running' },
  ],
  recentExecs: [
    { assetId: 'a1', toolName: 'ssh_exec', summary: 'grep error', tail: 'line 1\nline 2', ts: 100, sessionId: OWN_SESSION },
    { assetId: 'a2', toolName: 'db_query', summary: 'select 1', tail: 'x', ts: 99, sessionId: OTHER_SESSION },
    { assetId: 'a1', toolName: 'ssh_exec', summary: 'unattributed', tail: '', ts: 98 },
  ],
  taskTrails: [
    { sessionId: 'task-1', assetIds: ['a1', 'a2'] },
  ],
}

describe('truncateText', () => {
  it('keeps short text intact', () => {
    expect(truncateText('short', 10)).toBe('short')
  })

  it('keeps text at the exact limit intact', () => {
    expect(truncateText('12345', 5)).toBe('12345')
  })

  it('truncates long text to the limit with a trailing ellipsis', () => {
    expect(truncateText('1234567890', 5)).toBe('1234…')
    expect(truncateText('1234567890', 5)).toHaveLength(5)
  })
})

describe('composeLiveContext', () => {
  it('renders registry, per-asset events, and the live snapshot in order', async () => {
    const { request, transport } = makeTransport(SNAPSHOT)
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    expect(text).not.toBeNull()
    expect(text).toContain('StarHub live context:')
    expect(text).toContain('- a1: session s1 (ssh, attached by: shell)')
    expect(text).toContain('- a2: session s2 (db, attached by: none)')
    expect(text).toContain('- [a1] ssh.exec_completed: ran ls')
    expect(text).toContain('- [a2] db.query_executed (ai): select count')
    expect(text).not.toContain('session.attached')
    expect(text).toContain('- t1: a1 upload 512/1024 bytes (running)')
    expect(text).toContain('- a1 ssh_exec: grep error tail: line 1\nline 2')
    expect(text).toContain('[Task trails]')
    expect(text).toContain('- task-1: a1 → a2')
    expect(request).toHaveBeenCalledWith('starhub/live.snapshot', {})
    // Local sections precede the snapshot sections.
    expect(text?.indexOf('[Session registry]')).toBeLessThan(text?.indexOf('[Transfers]') ?? 0)
  })

  it('injects only this session\'s own AI execs and events (v0.140.3)', async () => {
    const { transport } = makeTransport(SNAPSHOT)
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    // 本会话自己的执行与 AI 事件在
    expect(text).toContain('- a1 ssh_exec: grep error tail: line 1\nline 2')
    expect(text).toContain('- [a2] db.query_executed (ai): select count')
    // 别的会话的执行(含输出尾)与 AI 事件不在;无归属(工具直调)的也不在
    expect(text).not.toContain('select 1')
    expect(text).not.toContain('other session query')
    expect(text).not.toContain('unattributed')
    // 用户起源事件(资产事实)不受会话过滤影响
    expect(text).toContain('- [a1] ssh.exec_completed: ran ls')
  })

  it('injects nothing AI-originated when the session has no own execs', async () => {
    const { transport } = makeTransport(SNAPSHOT)
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, 'third-session')

    expect(text).not.toContain('[Recent AI execs]')
    expect(text).not.toContain('db.query_executed (ai)')
    // registry / 用户事件 / 传输仍在
    expect(text).toContain('[Session registry]')
    expect(text).toContain('- [a1] ssh.exec_completed: ran ls')
    expect(text).toContain('[Transfers]')
  })

  it('falls back to global events when the registry is empty', async () => {
    const events = new DomainEventStore()
    events.push({ kind: 'session.attached', ts: 80, summary: 'shell attached' })
    const text = await composeLiveContext(new SessionRegistry(), events, undefined, 10, 4000, OWN_SESSION)

    expect(text).toContain('[Recent events]')
    expect(text).toContain('- [global] session.attached: shell attached')
    expect(text).not.toContain('[Session registry]')
    expect(text).not.toContain('[Transfers]')
  })

  it('renders the registry alone when events and transport are absent', async () => {
    const text = await composeLiveContext(seedRegistry(), undefined, undefined, 10, 4000, OWN_SESSION)

    expect(text).toContain('- a1: session s1 (ssh, attached by: shell)')
    expect(text).not.toContain('[Recent events]')
    expect(text).not.toContain('[Transfers]')
  })

  it('returns null when there is nothing to inject', async () => {
    expect(await composeLiveContext(undefined, undefined, undefined, 10, 4000, OWN_SESSION)).toBeNull()
  })

  it('returns null when the registry is empty and no events are buffered', async () => {
    expect(await composeLiveContext(new SessionRegistry(), new DomainEventStore(), undefined, 10, 4000, OWN_SESSION)).toBeNull()
  })

  it('degrades to the local view when the pull rejects', async () => {
    const { transport } = makeTransport(() => Promise.reject(new Error('host gone')))
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    expect(text).toContain('- a1: session s1 (ssh, attached by: shell)')
    expect(text).not.toContain('[Transfers]')
  })

  it('drops the snapshot when the pull returns a non-object', async () => {
    const { transport } = makeTransport('not an object')
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    expect(text).toContain('- a1: session s1 (ssh, attached by: shell)')
    expect(text).not.toContain('[Transfers]')
  })

  it('omits snapshot sections whose fields are not arrays or are empty', async () => {
    const { transport } = makeTransport({ transfers: 'nope', recentExecs: [] })
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    expect(text).toContain('[Session registry]')
    expect(text).not.toContain('[Transfers]')
    expect(text).not.toContain('[Recent AI execs]')
  })

  it('renders an exec without a tail as a bare summary', async () => {
    const { transport } = makeTransport({ recentExecs: [{ assetId: 'a1', toolName: 'memory', summary: 'remembered', sessionId: OWN_SESSION }] })
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 4000, OWN_SESSION)

    expect(text).toContain('- a1 memory: remembered')
    expect(text).not.toContain('tail:')
  })

  it('truncates the composed text to maxSnapshotChars', async () => {
    const { transport } = makeTransport(SNAPSHOT)
    const text = await composeLiveContext(seedRegistry(), seedEvents(), transport, 10, 60, OWN_SESSION)

    expect(text).not.toBeNull()
    expect(text?.length).toBe(60)
    expect(text?.endsWith('…')).toBe(true)
  })
})

describe('starhub-live-context plugin apply', () => {
  it('registers a pre-step listener that injects the composed snapshot', async () => {
    const registry = seedRegistry()
    const events = seedEvents()
    const { transport } = makeTransport(SNAPSHOT)
    const { ctx, listeners, on } = makeCtx({
      'starhub-session-registry': registry,
      'starhub-domain-events': events,
      'sdk-transport': transport,
    })

    apply(ctx, { enabled: true, maxEvents: 10, maxSnapshotChars: 4000 })

    expect(on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    expect(listeners).toHaveLength(1)
    const decision = await listeners[0]?.(
      preStepPayload(new AbortController().signal),
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision?.kind).toBe('enter')
    const messages = (decision as unknown as { kind: 'enter'; messages: Array<{ content: Array<{ type: string; text: string }> }> }).messages
    const injected = messages.at(-1)
    expect(injected?.content[0]).toMatchObject({ type: 'text' })
    expect(injected?.content[0]?.text).toContain('StarHub live context:')
    expect(injected?.content[0]?.text).toContain('- a1: session s1 (ssh, attached by: shell)')
    // 只注入本会话自己的 AI 执行(v0.140.3)
    expect(injected?.content[0]?.text).toContain('- a1 ssh_exec: grep error')
    expect(injected?.content[0]?.text).not.toContain('select 1')
  })

  it('scopes the injected execs to the calling agent session', async () => {
    const { ctx, listeners } = makeCtx({
      'starhub-session-registry': seedRegistry(),
      'starhub-domain-events': seedEvents(),
      'sdk-transport': makeTransport(SNAPSHOT).transport,
    })
    apply(ctx, { enabled: true, maxEvents: 10, maxSnapshotChars: 4000 })

    // 换一个自己没有执行记录的会话 id:快照里没有它的执行 → 无 AI execs 段,
    // 别的会话的执行(select 1 / other session query)不得出现
    const decision = await listeners[0]?.(
      preStepPayload(new AbortController().signal, 'third-session'),
      async () => ({ kind: 'enter', messages: [] }),
    )
    const messages = (decision as { kind: 'enter'; messages: Array<{ content: Array<{ type: string; text: string }> }> }).messages
    const injected = messages.at(-1)
    expect(injected?.content[0]?.text).toContain('StarHub live context:')
    expect(injected?.content[0]?.text).not.toContain('[Recent AI execs]')
    expect(injected?.content[0]?.text).not.toContain('select 1')
    expect(injected?.content[0]?.text).not.toContain('other session query')
    expect(injected?.content[0]?.text).toContain('- a1: session s1 (ssh, attached by: shell)')
  })

  it('appends the snapshot after the chain decision messages', async () => {
    const { ctx, listeners } = makeCtx({
      'starhub-session-registry': seedRegistry(),
      'starhub-domain-events': seedEvents(),
      'sdk-transport': makeTransport(SNAPSHOT).transport,
    })
    apply(ctx, { enabled: true, maxEvents: 10, maxSnapshotChars: 4000 })

    const prior = { kind: 'enter', messages: [{ id: 'prior-message' }] } as never
    const decision = await listeners[0]?.(
      preStepPayload(new AbortController().signal),
      async () => prior,
    )
    const messages = (decision as { kind: 'enter'; messages: unknown[] }).messages
    expect(messages[0]).toEqual({ id: 'prior-message' })
    expect(messages).toHaveLength(2)
  })

  it('passes through a rejected or aborted pre-step without injecting', async () => {
    const { ctx, listeners } = makeCtx({
      'starhub-session-registry': seedRegistry(),
      'starhub-domain-events': seedEvents(),
      'sdk-transport': makeTransport(SNAPSHOT).transport,
    })
    apply(ctx, { enabled: true, maxEvents: 10, maxSnapshotChars: 4000 })

    const rejected = await listeners[0]?.(
      preStepPayload(new AbortController().signal),
      async () => ({ kind: 'reject' }),
    )
    expect(rejected).toEqual({ kind: 'reject' })

    const aborted = new AbortController()
    aborted.abort()
    const passed = await listeners[0]?.(
      preStepPayload(aborted.signal),
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(passed).toEqual({ kind: 'enter', messages: [] })
  })

  it('injects nothing when compose yields null', async () => {
    const { ctx, listeners } = makeCtx({})
    apply(ctx, { enabled: true, maxEvents: 10, maxSnapshotChars: 4000 })

    const decision = await listeners[0]?.(
      preStepPayload(new AbortController().signal),
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('registers no listener when disabled', () => {
    const { ctx, listeners } = makeCtx({})
    apply(ctx, { enabled: false, maxEvents: 10, maxSnapshotChars: 4000 })
    expect(listeners).toHaveLength(0)
  })

  it.each([
    { enabled: true, maxEvents: 0, maxSnapshotChars: 4000 },
    { enabled: true, maxEvents: -1, maxSnapshotChars: 4000 },
    { enabled: true, maxEvents: 1.5, maxSnapshotChars: 4000 },
    { enabled: true, maxEvents: Number.NaN, maxSnapshotChars: 4000 },
    { enabled: true, maxEvents: 10, maxSnapshotChars: 0 },
    { enabled: true, maxEvents: 10, maxSnapshotChars: -4000 },
    { enabled: true, maxEvents: 10, maxSnapshotChars: 2.5 },
  ])('rejects invalid config at load: %o', (config) => {
    const { ctx } = makeCtx({})
    expect(() =>{  apply(ctx, config) }).toThrow(/starhub-live-context: (maxEvents|maxSnapshotChars) must be a positive safe integer/)
  })
})
