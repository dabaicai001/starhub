/**
 * 工具上下文 settings 通道(方案 4.3 / 契约 §6):client-nav 侧把「当前
 * StarHub 工具 + 资产」写入 `starhub-tool-context` settings namespace,host
 * 侧 tool-context 插件在 `agent/pre-step` 读取并注入 agent 请求。`@` 资产
 * source pick 的轻绑定与面板「问 AI」的资产上下文共用这一通道。
 *
 * v0.141.3 起按会话保存:`bindings[<sessionId>]` 一条 JSON,经
 * `settings.mutate` 的路径写入(以服务端已存的 section 为基准合并,不是
 * 读-改-写整份 namespace),因此两个终端页/两个助手先后绑定时互不覆盖。
 */

/** Settings namespace holding the current StarHub tool selection. */
export const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/** 单个会话的绑定条目(写入 `bindings[sessionId]` 的 JSON 形状)。 */
export interface ToolContextBinding {
  subcategory: string
  assetId: string
  assetName: string
  routePrefix: string
  assetType: string
  dbType: string
  /** 写入时间(毫秒);裁剪过期条目时按它排序。 */
  updatedAt: number
}

/**
 * 一条路径寻址的 settings 编辑(与 `@deepseek-ai/dsh-settings` 的
 * `SettingsPathOp` 结构相同;本包不依赖 host 侧类型包,故本地收窄)。
 */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * settings 写入的最小面。0.1.6 起 apiproxy 的 IApiClient 撤除,类型化 RPC
 * 改走 `ctx.remote`(api-gateway 的 ClientRemote);本包只需要按路径合并
 * 的 `mutate` 与整体合并的 `update` 两笔,故收窄成自己的小接口,调用点传
 * `ctx.remote.settings`。返回值形状随 remote 封装(`{ok,result}` 或裸值),
 * 由 {@link namespaceValue} 统一拆。
 */
export interface SettingsUpdateWriter {
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<unknown>
  mutate(
    ns: string,
    ops: readonly SettingsPathOp[],
    expectedRevision: number | undefined,
  ): Promise<unknown>
}

/**
 * 从一次 settings 写入的返回值里取出命名空间的解析值。
 *
 * remote 端可能回 `{ok:true, result:{value}}` 也可能直接回视图(测试替身),
 * 两者都接受;取不到就返回 undefined(裁剪逻辑据此跳过)。
 * @param reply - `update` / `mutate` 的返回值。
 * @returns 命名空间视图的 `value` 字段。
 */
export function namespaceValue(reply: unknown): unknown {
  if (typeof reply !== 'object' || reply === null) return undefined
  const envelope = reply as Record<string, unknown>
  const view = envelope.ok === false
    ? undefined
    : typeof envelope.result === 'object' && envelope.result !== null
      ? (envelope.result as Record<string, unknown>)
      : envelope
  if (view === undefined) return undefined
  return view.value
}

/** 选择桥快照里参与上下文补丁的两个字段(其余字段由工作区列单独维护)。 */
export interface ToolContextSelection {
  subcategory: string | null
  routePrefix: string | null
}

/** 绑定资产的类型元数据(key 命名与资产 config 一致)。 */
export interface ToolContextAssetMeta {
  /** 资产大类 id / name(如 db / ssh / docker / local)。 */
  assetType: string
  /** 数据库子类型(redis / mysql / clickhouse / …);非 DB 资产为空。 */
  dbType?: string
}

/** `bindings` 条目上限:超过就裁掉最旧的,避免 settings 文件无限增长。 */
export const MAX_TOOL_CONTEXT_BINDINGS = 48

/** 正在裁剪时的标记:并发绑定只跑一次裁剪,不重复写。 */
let pruning = false

/**
 * 把超过上限的会话绑定裁到最近的 {@link MAX_TOOL_CONTEXT_BINDINGS} 条。
 *
 * 只在写入返回的视图确实超限时触发一次,不额外读 settings。
 * @param writer - settings 写入面。
 * @param reply - 上一次写入的返回值(`{ok,result}` 或视图本身)。
 */
function pruneBindings(writer: SettingsUpdateWriter, reply: unknown): void {
  if (pruning) return
  const value = namespaceValue(reply)
  if (typeof value !== 'object' || value === null) return
  const raw = (value as Record<string, unknown>).bindings
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length <= MAX_TOOL_CONTEXT_BINDINGS) return
  const kept: Record<string, string> = {}
  const ordered = entries
    .map(([sessionId, text]) => {
      let updatedAt = 0
      if (typeof text === 'string') {
        try {
          const parsed: unknown = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) {
            const stamp = (parsed as Record<string, unknown>).updatedAt
            if (typeof stamp === 'number') updatedAt = stamp
          }
        } catch {
          // 坏条目按最旧处理,优先被裁掉。
        }
      }
      return { sessionId, text: typeof text === 'string' ? text : '', updatedAt }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TOOL_CONTEXT_BINDINGS)
  for (const entry of ordered) kept[entry.sessionId] = entry.text
  pruning = true
  void writer.update(TOOL_CONTEXT_NAMESPACE, { bindings: kept }, undefined)
    .catch(() => {})
    .finally(() => { pruning = false })
}

/**
 * 轻绑定一个资产到工具上下文:按会话写入 `bindings[<sessionId>]`,失败静默
 * ——上下文是尽力而为的提示,不打断输入、不切窗口。
 *
 * 每个会话一条,互不覆盖(同一会话重复绑定就地更新);host 侧 tool-context
 * 插件在 pre-step 只读取 `agent.session.id` 自己那一条,避免全局粘性让每条
 * 普通对话都带上 starhub-tool-context。
 * @param writer - settings 写入面(`ctx.remote.settings`)。
 * @param selection - 当前选择桥快照(subcategory / routePrefix)。
 * @param asset - 目标资产(id + 显示名)。
 * @param sessionId - 触发本次绑定的会话 id(会话级作用域)。
 */
export function bindAssetContext(
  writer: SettingsUpdateWriter,
  selection: ToolContextSelection,
  asset: { id: string; name: string; type?: string; config?: Record<string, unknown> },
  sessionId: string,
): void {
  const config = asset.config ?? {}
  const meta: ToolContextAssetMeta = {
    assetType: asset.type ?? '',
    ...(typeof config.dbType === 'string' && config.dbType !== ''
      ? { dbType: config.dbType }
      : {}),
  }
  const binding: ToolContextBinding = {
    subcategory: selection.subcategory ?? '',
    assetId: asset.id,
    assetName: asset.name,
    routePrefix: selection.routePrefix ?? '',
    assetType: meta.assetType,
    dbType: meta.dbType ?? '',
    updatedAt: Date.now(),
  }
  void writer.mutate(
    TOOL_CONTEXT_NAMESPACE,
    [{ op: 'set', path: ['bindings', sessionId], value: JSON.stringify(binding) }],
    undefined,
  ).then((view) => { pruneBindings(writer, view) }).catch(() => {})
}
