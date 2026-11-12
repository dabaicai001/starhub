/**
 * StarHub tool context(方案第 4 章 4.3):把「当前 StarHub 工具 + 资产」注入
 * 每个 agent 请求的上下文。
 *
 * 数据流:client-nav(浏览器壳)在用户选择子类/资产时,经 settings 通道
 * (`settings.update`)写入 `starhub-tool-context` namespace(当前子类、
 * 资产 id、资产名、路由前缀);本插件(host)在 `agent/pre-step` 时读取该
 * namespace,有选中工具则注入一条 plugin 来源的 user message,让模型
 * 感知「用户当前在哪个 StarHub 工具、哪个连接上」。
 *
 * 无选中工具/无数据时注入为空(no-op):不打扰正常对话。
 *
 * @module @deepseek-ai/dsh-starhub-tool-context
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-starhub-tool-context': { kind: 'dsh-starhub-tool-context', plugin: string } & ContextFormed
  }
}
// Type-only: ctx.settings 的 Context 声明合并(register/get 类型化)。import type {} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'starhub-tool-context'

/** The agent registry (settings 命名空间由 Config 派生,无需注入 settings 服务)。 */
export const inject = ['agents']

/** Settings namespace holding the current StarHub tool selection (profile entry id). */
export const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/** Schema-validated shape written by client-nav. */
export interface StarHubToolContextValue {
  /** 触发本次绑定的会话 id;仅该会话在 pre-step 时注入(会话级作用域)。 */
  sessionId?: string
  /** 当前子类 key(terminal / database / docker);空 = 未选中。 */
  subcategory?: string
  /** 当前选中资产的 id;空 = 未选中资产。 */
  assetId?: string
  /** 当前选中资产的显示名。 */
  assetName?: string
  /** 子类段路由前缀(如 /ssh),供 AI 建议打开时拼实例 URL。 */
  routePrefix?: string
  /** 资产大类 id(db / ssh / docker / local);空 = 未标注。 */
  assetType?: string
  /** 数据库子类型(redis / mysql / clickhouse / …);非 DB 资产缺省。 */
  dbType?: string
}

/** Schemastery validation for the namespace value. */
export const ToolContextSchema: z<StarHubToolContextValue> = z.object({
  sessionId: z.string(),
  subcategory: z.string(),
  assetId: z.string(),
  assetName: z.string(),
  routePrefix: z.string(),
  assetType: z.string(),
  dbType: z.string(),
})

/**
 * 插件 Config(DSH 0.1.7 起 settings 命名空间由插件 Config 的 volatile 字段派生,
 * 旧 `ctx.settings.register` 面已移除)。client-nav 经 `settings.mutate` 按会话
 * 写入 `bindings[<sessionId>]`(JSON 字符串);volatile 引用由 Loader 热提交,
 * pre-step 时 `.get()` 即活值。
 *
 * 顶层的 `sessionId`/`assetId`/… 单槽字段是 v0.141.2 之前的写法:两个终端页
 * (或两个助手)先后绑定会互相覆盖,后绑定的会话把前一个的上下文挤掉。它们现在
 * 只作为升级前的存量数据兜底保留,新写入一律走 `bindings`。
 */
export interface Config {
  sessionId: Volatile<string>
  subcategory: Volatile<string>
  assetId: Volatile<string>
  assetName: Volatile<string>
  routePrefix: Volatile<string>
  assetType: Volatile<string>
  dbType: Volatile<string>
  /** 会话 id → 该会话绑定的上下文(JSON 字符串);按会话隔离,互不覆盖。 */
  bindings: Volatile<Record<string, string>>
}

/** Plugin Config: every GUI-editable namespace field as one live volatile reference. */
export const Config = z.object({
  sessionId: z.string().default('').volatile(),
  subcategory: z.string().default('').volatile(),
  assetId: z.string().default('').volatile(),
  assetName: z.string().default('').volatile(),
  routePrefix: z.string().default('').volatile(),
  assetType: z.string().default('').volatile(),
  dbType: z.string().default('').volatile(),
  bindings: z.dict(z.string()).default({}).volatile(),
})

/**
 * 一个会话的绑定条目(client-nav 写入 `bindings[sessionId]` 的 JSON 形状)。
 *
 * 字段一律 `可选 + 显式 undefined`:读入口径是「取到就带、取不到为 undefined」,
 * 与 `exactOptionalPropertyTypes` 下「存在但为 undefined」的赋值语义一致。
 */
export interface ToolContextBinding {
  /** 当前子类 key(terminal / database / docker);空 = 未选中。 */
  subcategory?: string | undefined
  /** 当前选中资产的 id。 */
  assetId?: string | undefined
  /** 当前选中资产的显示名。 */
  assetName?: string | undefined
  /** 子类段路由前缀(如 /ssh)。 */
  routePrefix?: string | undefined
  /** 资产大类 id(db / ssh / docker / local)。 */
  assetType?: string | undefined
  /** 数据库子类型(redis / mysql / clickhouse / …)。 */
  dbType?: string | undefined
  /** 写入时间(毫秒);client-nav 据此裁剪过期条目。 */
  updatedAt?: number | undefined
}

/**
 * Parse the `bindings` settings value into per-session entries.
 *
 * Tolerant by design: one malformed entry (hand-edited settings, an older
 * client) must not silence every other session's context. Field values are
 * re-typed here because this is a durable/user-editable boundary.
 * @param raw - `bindings` config value (session id → JSON string).
 * @returns parsed entries keyed by session id; malformed entries are skipped.
 */
export function parseBindings(raw: Record<string, string> | undefined): Record<string, ToolContextBinding> {
  const result: Record<string, ToolContextBinding> = {}
  for (const [sessionId, text] of Object.entries(raw ?? {})) {
    if (typeof text !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // 该条目的写入方已经坏掉(或手改坏了):跳过它,不影响其它会话。
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const field = (key: string): string | undefined =>
      typeof record[key] === 'string' ? record[key] : undefined
    result[sessionId] = {
      subcategory: field('subcategory'),
      assetId: field('assetId'),
      assetName: field('assetName'),
      routePrefix: field('routePrefix'),
      assetType: field('assetType'),
      dbType: field('dbType'),
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : undefined,
    }
  }
  return result
}

/**
 * Resolve one session's tool context.
 *
 * Per-session bindings win; the pre-v0.141.3 single-slot fields are only a
 * fallback for values written before the upgrade (they keep working because
 * the stored settings file still carries them).
 * @param config - live plugin config.
 * @param sessionId - the agent session being stepped.
 * @returns the session's context, or an empty value when it has none.
 */
export function readToolContextFor(config: Config, sessionId: string): StarHubToolContextValue {
  const bound = parseBindings(config.bindings.get())[sessionId]
  if (bound !== undefined) {
    return {
      sessionId,
      subcategory: bound.subcategory ?? '',
      assetId: bound.assetId ?? '',
      assetName: bound.assetName ?? '',
      routePrefix: bound.routePrefix ?? '',
      assetType: bound.assetType ?? '',
      dbType: bound.dbType ?? '',
    }
  }
  const legacy = readToolContext(config)
  return legacy.sessionId === sessionId ? legacy : { sessionId: '' }
}

/** Detach the live config references into the plain value shape the injector renders. */
export function readToolContext(config: Config): StarHubToolContextValue {
  return {
    sessionId: config.sessionId.get(),
    subcategory: config.subcategory.get(),
    assetId: config.assetId.get(),
    assetName: config.assetName.get(),
    routePrefix: config.routePrefix.get(),
    assetType: config.assetType.get(),
    dbType: config.dbType.get(),
  }
}

/**
 * Render one injectable tool-context text from a non-empty selection.
 * @param value - the current StarHub tool selection (namespace value).
 * @returns the injectable text, or null when neither tool nor asset is selected.
 */
export function renderToolContext(value: StarHubToolContextValue): string | null {
  const tool = value.subcategory ?? ''
  const asset = value.assetName ?? value.assetId ?? ''
  if (tool === '' && asset === '') return null
  const lines = [
    'Current StarHub tool context:',
    `- Tool: ${tool === '' ? 'none' : tool}`,
    `- Asset: ${asset === '' ? 'none' : asset}`,
    ...(value.routePrefix !== undefined && value.routePrefix !== ''
      ? [`- Route: ${value.routePrefix}`]
      : []),
  ]
  // 资产类型提示:让模型准确选择工具族(DB 资产绝不调 SSH 工具)。
  if ((value.assetType !== undefined && value.assetType !== '') || (value.dbType !== undefined && value.dbType !== '')) {
    const assetType = value.assetType ?? ''
    const dbType = value.dbType ?? ''
    lines.push(`- Asset type: ${dbType !== '' ? `database (${dbType})` : assetType}`)
  }
  const toolHint = toolHintFor(value)
  if (toolHint !== null) {
    lines.push(toolHint)
  }
  // Docker 资产硬约束(死规定):任何删除类操作必须先征得用户明确确认。
  // 与 @ 引用标注、approval-bridge 风险门三层一致,不允许模型自行删除。
  if (tool === 'docker') {
    lines.push(
      '- Docker delete guard (hard rule): never run destructive Docker commands '
      + '(rm/rmi/prune — container, image, volume, network, system —, compose down/rm, '
      + 'stack/service/config/secret/plugin rm). If deletion is truly required, ask the '
      + 'user for explicit confirmation and only proceed after approval.',
    )
  }
  return lines.join('\n')
}

/** 按资产类型给出「该用什么工具族」的一行提示(DB 资产明确禁止 SSH 工具)。 */
function toolHintFor(value: StarHubToolContextValue): string | null {
  const dbType = value.dbType ?? ''
  const assetType = value.assetType ?? ''
  if (dbType !== '') {
    if (dbType === 'redis') return '- Preferred tool: redis_exec (Redis commands) — NOT ssh_exec/sftp_*.'
    if (dbType === 'elasticsearch') return '- Preferred tool: es_* (Elasticsearch) — NOT ssh_exec/sftp_*.'
    return '- Preferred tool: db_query (SQL) — NOT ssh_exec/sftp_*.'
  }
  if (assetType === 'db') return '- Preferred tool: db_query (SQL) — NOT ssh_exec/sftp_*.'
  return null
}

/**
 * Register the plugin: settings 命名空间由本插件的 Config volatile 字段派生
 * (DSH 0.1.7),pre-step 时按开关 + 当前 StarHub 工具选择注入上下文。
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - live tool-context references (Loader 热提交)。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // 会话级作用域:只读本会话自己的绑定(按会话保存,两个终端页/助手互不覆盖);
    // 没有绑定的会话不注入,避免全局粘性让每条对话都带上工具上下文。
    const value = readToolContextFor(config, agent.session.id)
    const text = renderToolContext(value)
    if (text === null) return decision
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-starhub-tool-context', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
