/**
 * StarHub live context(联动契约 §2.2/§5,StarHub 本地包,不在上游;方案 M3)。
 * `agent/pre-step` 插件:把「当前在发生什么」注入每个 agent 请求——
 * 1. registry 快照(`starhub-session-registry` 服务,契约 §2.1);
 * 2. 相关资产最近 N 条领域事件 summary(`starhub-domain-events` 服务,
 *    `recent(assetId, maxEvents)`,契约 §1);
 * 3. 经 `sdk-transport` 反向 RPC pull `starhub/live.snapshot`(契约 §2.2,
 *    transfers + recentExecs)。
 *
 * 整段文本按 `maxSnapshotChars` 截断(默认 4000,从头保留:registry/事件在前,
 * 快照尾部先被裁掉)。pull 失败降级为本地 registry+events,不抛错;本地服务
 * 缺失时逐段降级。`enabled: false` 时完全不注入。
 *
 * **会话级收敛(v0.140.3)**:AI 起源的内容(recentExecs、AI 起源事件)按发起
 * 会话 id 过滤,只放行当前 agent 会话自己产生的执行——用户在主壳会话里聊天的
 * 时候,不再看到 SSH 终端页助手刚在另一条会话里跑过的命令(反之亦然)。用户
 * 起源事件(终端连接/断开等)是资产事实,无会话归属,全局保留。
 *
 * 格式风格对齐 tool-context 的 pre-step 注入:同一 plugin-source user message
 * (`form: 'snapshot'`,sections 携带包名与全文)。
 *
 * @module @deepseek-ai/dsh-starhub-live-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionRegistry, StarHubSessionRecord } from '@deepseek-ai/dsh-starhub-session-registry'
import type { DomainEventStore, StarHubDomainEvent } from '@deepseek-ai/dsh-starhub-domain-events'
import { LiveSnapshotCache } from './snapshot-cache.ts'

// DSH 0.1.7:MessageSourceMap 是merge-extensible 联合,生产者自行声明 kind
// (共享 catch-all `plugin` kind 已移除)。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-starhub-live-context': { kind: 'dsh-starhub-live-context', plugin: string } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-live-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** 桥方法名;Rust 侧实现见 src-tauri/src/harness/mod.rs(契约 §2.2)。 */
const LIVE_SNAPSHOT_METHOD = 'starhub/live.snapshot'

/** 一次快照 pull 的默认预算(首步最多等这么久;之后走缓存)。 */
const LIVE_SNAPSHOT_TIMEOUT_MS = 800

/** 缓存 TTL:超过这个年龄的快照在后台刷新,不阻塞当前步。 */
const LIVE_SNAPSHOT_TTL_MS = 3_000

/** pull 失败后的冷却:这段期间不再试,避免每一步都等满预算。 */
const LIVE_SNAPSHOT_COOLDOWN_MS = 15_000

/** 截断时追加的省略号(截断后总长仍 ≤ maxSnapshotChars)。 */
const TRUNCATION_ELLIPSIS = '…'

/** 每步注入的活体上下文配置;非法值在加载时 fail loud。 */
export interface Config {
  /** 是否注入;默认 true。 */
  enabled?: boolean
  /** 每个相关资产最多注入的事件条数;默认 10。 */
  maxEvents?: number
  /** 整段注入文本的字符上限;默认 4000。 */
  maxSnapshotChars?: number
  /** 快照 pull 的单次预算(毫秒);默认 800。 */
  snapshotTimeoutMs?: number
  /** 快照缓存 TTL(毫秒),超龄后台刷新;默认 3000。 */
  snapshotTtlMs?: number
  /** pull 失败后的冷却(毫秒);默认 15000。 */
  snapshotCooldownMs?: number
}

/** Schemastery validation for {@link Config}(cordis 加载时应用默认值)。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxEvents: z.number().default(10),
  maxSnapshotChars: z.number().default(4000),
  snapshotTimeoutMs: z.number().default(LIVE_SNAPSHOT_TIMEOUT_MS),
  snapshotTtlMs: z.number().default(LIVE_SNAPSHOT_TTL_MS),
  snapshotCooldownMs: z.number().default(LIVE_SNAPSHOT_COOLDOWN_MS),
})

/** `starhub/live.snapshot` 的 result(契约 §2.2)。 */
interface LiveSnapshot {
  readonly transfers?: Array<Record<string, unknown>>
  readonly recentExecs?: Array<Record<string, unknown>>
  readonly taskTrails?: Array<Record<string, unknown>>
}

/** recentExecs 条目里发起会话的字段名(v0.140.3 起 sidecar 落库)。 */
const EXEC_SESSION_FIELD = 'sessionId'

/**
 * 一条 recentExecs 是否属于当前会话(v0.140.3 会话级收敛)。
 *
 * 没有 `sessionId` 的条目(工具直调形态,未经桥信封注入)无法归属,按「非本
 * 会话」处理——不注入,避免把来源不明的执行塞进任何会话的上下文。
 * @param exec - `starhub/live.snapshot` 的一条 recentExecs。
 * @param sessionId - 当前 agent 会话 id(agent.session.id)。
 */
function execBelongsToSession(exec: Record<string, unknown>, sessionId: string): boolean {
  const origin = exec[EXEC_SESSION_FIELD]
  return typeof origin === 'string' && origin === sessionId
}

/**
 * 校验活体上下文配置。
 * @param config - 已解析(含默认值)的配置。
 * @throws 当计数/预算不是正整数时。
 */
function validateConfig(config: {
  maxEvents: number
  maxSnapshotChars: number
  snapshotTimeoutMs: number
  snapshotTtlMs: number
  snapshotCooldownMs: number
}): void {
  if (!Number.isSafeInteger(config.maxEvents) || config.maxEvents <= 0) {
    throw new TypeError(`starhub-live-context: maxEvents must be a positive safe integer, got ${String(config.maxEvents)}`)
  }
  if (!Number.isSafeInteger(config.maxSnapshotChars) || config.maxSnapshotChars <= 0) {
    throw new TypeError(`starhub-live-context: maxSnapshotChars must be a positive safe integer, got ${String(config.maxSnapshotChars)}`)
  }
  for (const [key, value] of Object.entries({
    snapshotTimeoutMs: config.snapshotTimeoutMs,
    snapshotTtlMs: config.snapshotTtlMs,
    snapshotCooldownMs: config.snapshotCooldownMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`starhub-live-context: ${key} must be a positive safe integer, got ${String(value)}`)
    }
  }
}

/** 渲染一条 session 记录行。 */
function renderSessionLine(record: StarHubSessionRecord): string {
  const attached = record.attachedBy.length === 0 ? 'none' : record.attachedBy.join(', ')
  return `- ${record.assetId}: session ${record.sessionId} (${record.kind}, attached by: ${attached})`
}

/** 渲染一条事件摘要行;AI 起源事件带标记。 */
function renderEventLine(event: StarHubDomainEvent): string {
  const scope = event.assetId ?? 'global'
  const origin = event.origin === 'ai' ? ' (ai)' : ''
  return `- [${scope}] ${event.kind}${origin}: ${event.summary}`
}

/**
 * AI 起源事件是否属于当前会话(v0.140.3 会话级收敛)。
 *
 * 用户起源事件(终端连接/断开等)没有会话归属,是资产事实,全局保留;AI 起源
 * 事件必须带 `sessionId` 且等于当前 agent 会话才注入——否则主壳会话会看到
 * 别的会话(SSH 页助手等)刚执行过的命令摘要。
 * @param event - 一条领域事件。
 * @param sessionId - 当前 agent 会话 id(agent.session.id)。
 */
function eventBelongsToSession(event: StarHubDomainEvent, sessionId: string): boolean {
  if (event.origin !== 'ai') return true
  return event.sessionId !== undefined && event.sessionId === sessionId
}

/**
 * 渲染本地 registry + 事件视图。
 * @param records - 当前活跃 session 记录。
 * @param events - 事件服务;缺失时该段省略。
 * @param maxEvents - 每资产事件条数上限。
 * @param sessionId - 当前 agent 会话 id(AI 起源事件按它过滤)。
 * @returns 本地段文本;空段返回 ''。
 */
function renderLocalSections(
  records: readonly StarHubSessionRecord[],
  events: DomainEventStore | undefined,
  maxEvents: number,
  sessionId: string,
): string {
  const sections: string[] = []
  if (records.length > 0) {
    sections.push('[Session registry]')
    sections.push(...records.map(renderSessionLine))
    const assetIds = [...new Set(records.map(record => record.assetId))]
    const eventLines: string[] = []
    for (const assetId of assetIds) {
      for (const event of events?.recent(assetId, maxEvents) ?? []) {
        if (eventBelongsToSession(event, sessionId)) eventLines.push(renderEventLine(event))
      }
    }
    if (eventLines.length > 0) {
      sections.push('[Recent events]')
      sections.push(...eventLines)
    }
  } else if (events !== undefined) {
    const recent = events.recent(undefined, maxEvents)
      .filter(event => eventBelongsToSession(event, sessionId))
    if (recent.length > 0) {
      sections.push('[Recent events]')
      sections.push(...recent.map(renderEventLine))
    }
  }
  return sections.join('\n')
}

/** 渲染一条传输行。 */
function renderTransferLine(transfer: Record<string, unknown>): string {
  return `- ${String(transfer.id)}: ${String(transfer.assetId)} ${String(transfer.direction)} `
    + `${String(transfer.bytes)}/${String(transfer.totalBytes)} bytes (${String(transfer.state)})`
}

/** 渲染一条最近 AI 执行行(含输出尾部)。 */
function renderExecLine(exec: Record<string, unknown>): string {
  const tail = typeof exec.tail === 'string' && exec.tail !== '' ? ` tail: ${exec.tail}` : ''
  return `- ${String(exec.assetId)} ${String(exec.toolName)}: ${String(exec.summary)}${tail}`
}

/**
 * 渲染 pull 到的活性快照段。
 * @param snapshot - `starhub/live.snapshot` 的 result;缺失或字段非数组时该段省略。
 * @param sessionId - 当前 agent 会话 id(recentExecs 按它过滤,v0.140.3)。
 * @returns 快照段文本;无内容返回 ''。
 */
function renderSnapshotSections(snapshot: LiveSnapshot | undefined, sessionId: string): string {
  if (snapshot === undefined) return ''
  const sections: string[] = []
  const transfers = snapshot.transfers
  if (Array.isArray(transfers) && transfers.length > 0) {
    sections.push('[Transfers]')
    sections.push(...transfers.map(renderTransferLine))
  }
  const execs = snapshot.recentExecs
  if (Array.isArray(execs)) {
    // 只放行本会话自己产生的执行:别的会话(主壳 / 其它终端页助手)跑过的
    // 命令连同输出尾部,不注入当前会话的上下文。
    const own = execs.filter(exec => execBelongsToSession(exec, sessionId))
    if (own.length > 0) {
      sections.push('[Recent AI execs]')
      sections.push(...own.map(renderExecLine))
    }
  }
  const trails = snapshot.taskTrails
  if (Array.isArray(trails) && trails.length > 0) {
    sections.push('[Task trails]')
    sections.push(...trails.map(trail => `- ${String(trail.sessionId)}: ${Array.isArray(trail.assetIds) ? trail.assetIds.map(String).join(' → ') : 'none'}`))
  }
  return sections.join('\n')
}

/**
 * 截断到字符上限;超长时尾部加省略号(总长仍 ≤ maxChars)。
 * @param text - 原始文本。
 * @param maxChars - 结果总长上限(含省略号)。
 * @returns 截断后的文本。
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - TRUNCATION_ELLIPSIS.length))}${TRUNCATION_ELLIPSIS}`
}

/**
 * 组装一次注入的活体上下文文本;pull 失败降级为本地视图,不抛错。
 *
 * v0.140.3 起 AI 起源内容(recentExecs 与 AI 起源事件)按 `sessionId` 做
 * **会话级过滤**:只放行当前 agent 会话自己产生的执行,别的会话执行过什么
 * 不再串进本会话的上下文。
 * @param registry - 注册表服务;缺失时本地 registry 段省略。
 * @param events - 事件服务;缺失时本地事件段省略。
 * @param transport - sdk-transport;缺失或 pull 失败时快照段省略。
 * @param maxEvents - 每相关资产的事件条数上限。
 * @param maxSnapshotChars - 整段文本字符上限。
 * @param sessionId - 当前 agent 会话 id(agent.session.id)。
 * @param cache - 快照缓存(插件 apply 里创建);缺省时直接 pull 并受 2s 预算约束
 *   (单测/直调路径),传缓存后每步优先用上一次的快照,刷新在后台进行。
 * @returns 注入文本;本地与快照段都为空时返回 null(不注入)。
 */
export async function composeLiveContext(
  registry: SessionRegistry | undefined,
  events: DomainEventStore | undefined,
  transport: JsonRpcTransportPeer | undefined,
  maxEvents: number,
  maxSnapshotChars: number,
  sessionId: string,
  cache?: LiveSnapshotCache,
): Promise<string | null> {
  const sections: string[] = []
  const records = registry?.list() ?? []
  const local = renderLocalSections(records, events, maxEvents, sessionId)
  if (local !== '') sections.push(local)
  let snapshot: LiveSnapshot | undefined
  if (transport !== undefined) {
    const pull = (): Promise<unknown> => transport.request(LIVE_SNAPSHOT_METHOD, {})
    if (cache === undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error('starhub/live.snapshot timed out')) }, LIVE_SNAPSHOT_TIMEOUT_MS)
        })
        const result: unknown = await Promise.race([pull(), timeoutPromise])
        snapshot = typeof result === 'object' && result !== null ? result : undefined
      } catch {
        // pull 失败/超时(宿主报错、进程断开或未实现)降级为本地 registry+events,不打断 pre-step。
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    } else {
      const result = await cache.get(pull)
      snapshot = typeof result === 'object' && result !== null ? result : undefined
    }
  }
  const live = renderSnapshotSections(snapshot, sessionId)
  if (live !== '') sections.push(live)
  if (sections.length === 0) return null
  const text = ['StarHub live context:', ...sections].join('\n')
  return truncateText(text, maxSnapshotChars)
}

/**
 * 注册插件:在每次 agent pre-step 注入活体上下文。
 * @param ctx - plugin context;监听器随插件 fiber 卸载。
 * @param config - 注入配置(cordis 已应用 schema 默认值)。
 * @throws 当 maxEvents / maxSnapshotChars / 快照预算非法时。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = {
    enabled: config.enabled ?? true,
    maxEvents: config.maxEvents ?? 10,
    maxSnapshotChars: config.maxSnapshotChars ?? 4000,
    snapshotTimeoutMs: config.snapshotTimeoutMs ?? LIVE_SNAPSHOT_TIMEOUT_MS,
    snapshotTtlMs: config.snapshotTtlMs ?? LIVE_SNAPSHOT_TTL_MS,
    snapshotCooldownMs: config.snapshotCooldownMs ?? LIVE_SNAPSHOT_COOLDOWN_MS,
  }
  if (!resolved.enabled) return
  validateConfig(resolved)
  ctx.effect(() => {
    // 宿主私有服务名(starhub-session-registry / starhub-domain-events /
    // sdk-transport)不走 Context 接口声明合并,读取后自行窄化;缺失即降级,
    // 不 fail loud。
    // registry / events 是两个 store 服务,加载拓扑稳定,effect 阶段读一次即可;
    // transport 每次 pre-step 现取:提供方(starhub-bridge 的 apply 是异步的——
    // spawn + 健康探针之后才 provide)可能晚于本插件 apply,读一次就永久丢掉
    // 快照段。
    const registry = ctx.get('starhub-session-registry') as SessionRegistry | undefined
    const events = ctx.get('starhub-domain-events') as DomainEventStore | undefined
    const getTransport = (): JsonRpcTransportPeer | undefined =>
      ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined
    // 快照缓存:一次 pull 的结果服务后续每一步,刷新在后台进行——慢 sidecar 不再
    // 让每个模型步都等满预算(v0.141.4)。
    const cache = new LiveSnapshotCache({
      timeoutMs: resolved.snapshotTimeoutMs,
      ttlMs: resolved.snapshotTtlMs,
      cooldownMs: resolved.snapshotCooldownMs,
    })

    return ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      // 会话级收敛(v0.140.3):AI 起源的执行/事件只放行本会话自己产生的——
      // 主壳会话不再看到 SSH 页助手刚跑过的命令,反之亦然。
      const text = await composeLiveContext(
        registry, events, getTransport(), resolved.maxEvents, resolved.maxSnapshotChars,
        String(agent.session.id), cache,
      )
      if (text === null) return decision
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'dsh-starhub-live-context', plugin: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      }
    }, { prepend: true })
  }, 'starhub-live-context: pre-step injection')
}
