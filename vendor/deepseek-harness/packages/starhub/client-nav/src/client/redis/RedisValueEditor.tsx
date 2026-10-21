/**
 * Redis 值编辑器(受控 props 版)。
 *
 * 工作台把「当前打开的 key」以 `redisKey` / `keyType` props 传入(并以
 * React key 强制按 key 重挂载);保存成功后经 `onSaved` 回调通知工作台
 * 刷新键列表与 db 键数(旧版保存后两侧状态静默漂移)。
 *
 * 按类型渲染:string → 文本编辑器;hash/list/set/zset → 结构字段表
 * (hash 字段+值,list 索引+值,set 单成员列,zset 成员+分数)。读写全走
 * redis-service(db_redis_get_value 读取 / db_redis_set 与 db_redis_execute
 * 写回),TTL 输入置于信息条,dirty 态决定「还原/保存」可用性。结构类型保存
 * 按原生命令拼装(redisQuote);字段改名(set/zset/hash)先 DEL 旧成员再 ADD
 * 新成员;list 新增行走 RPUSH;list 删除走哨兵值 + LREM 0(按索引精确删除,
 * 见 saveList)。
 *
 * P0 修复(TTL=0 删 key):Redis 的 `EXPIRE key 0` 语义是「立即删除该 key」。
 * 旧版只校验 `expiration < 0`,用户填 0(或 key 剩余 TTL 恰为 0 时回填)就会
 * 在保存时把 key 删掉,且 string 与结构类型行为不一致(string 走 SET 不带 EX
 * 不会删)。现在 0 与空串一律归一为「持久化」,结构类型显式下发 PERSIST。
 *
 * P0 修复(zset 解析错位):sidecar 的 GetValue 对 zset 返回
 * `[{value, score}]` 对象数组(ZRangeWithScores 的结构化结果),旧版却按
 * `[[member, score]]` 数组成员解析,导致成员列渲染成 JSON 串、分数列空白,
 * 保存时 ZADD 出一个垃圾成员。rowsFromValue 现在同时兼容对象与数对两种
 * 形状(数对形状保留给既有单测)。
 *
 * P1 修复(revertRows 空串被覆盖):旧版用 `originalValue || value`,`''`
 * (falsy)会回退到编辑中的值,导致「原值为空串」的行还原不干净。改用显式
 * undefined 判定。
 *
 * P1 修复(list 按值删错元素):旧版删除走 `LREM key 1 <originalValue>`,按
 * **值**删除——list 允许重复值,删索引 0 时若值重复会删到别的实例。改为
 * 哨兵值方案:先 LSET 把待删索引改写成唯一哨兵,再 LREM 0 一次清掉,删除
 * 精确落在标记的索引上。
 *
 * 集合被删空时 Redis 会自动移除 key:保存前在 footer 给出非阻塞警示,避免
 * 「保存成功但 key 不见了」的静默数据丢失。
 *
 * v0.136.6:
 * - **以服务端 get_value 的 type 为准**(SCAN 缓存类型可能过期):type=none 时
 *   明确提示「Key 不存在」并禁用保存/TTL,不再把 null 序列化成 "null" 后可保存;
 *   缓存说是 string 而实际是 hash 时按 hash 渲染。
 * - **采样提示与空集合警示修正**:sidecar 对大集合只回传前 N 项,现在用 size
 *   标出「仅加载前 N 项(共 M 项)」;只加载了部分时删完可见项并不会清空 key,
 *   因此不再误报「保存后集合为空」。
 *
 * string 值为合法 JSON(对象/数组)时,编辑区上方提供「原文 / 格式化」切换:
 * 格式化视图是 pretty-print 的**只读**展示,编辑与保存始终基于原文(格式化
 * 产物不回写,避免用户以为改了格式就改了值)。
 *
 * @module Redis value editor (client)
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IconCloseFillMedium, IconCloseOutlineMedium, IconCopyOutlineMedium, IconPlusOutlineMedium, IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  redisExecute, redisGetValue, redisQuote, redisSet,
  type RedisCommandResult,
} from './redis-service.ts'
import css from './RedisValueEditor.module.css'

/** 结构类型字段行(hash/list/set/zset 通用;zset 用 value 承载 score)。 */
interface FieldRow {
  field: string
  value: string
  originalField: string
  originalValue: string
  deleted: boolean
}

/** 单个 key 的编辑模型。 */
interface KeyModel {
  loading: boolean
  saving: boolean
  error: string
  /**
   * 服务端实际返回的类型(来自 get_value)。SCAN 缓存的类型可能过期(key 在
   * 两次操作之间被改类型/删除),渲染与写回都应以服务端为准;空串表示尚未加载。
   */
  type: string
  /** 结构类型集合的总条目数(DBSIZE 语义);string / 未知时为 undefined。 */
  size?: number
  /** string 类型当前文本。 */
  text: string
  /** string 类型加载时文本(还原目标)。 */
  originalText: string
  /** 结构类型行(可能只是前 N 项采样)。 */
  rows: FieldRow[]
}

/** 单元格显示文本:nullish → 空串,对象 JSON 化,其余原样字符串化。 */
function toCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  const primitive = v as string | number | boolean | bigint | symbol
  return String(primitive)
}

/**
 * 从 get_value 载荷解析结构类型行(list 用索引作 field)。
 *
 * zset 兼容两种形状:sidecar 实际返回的 `[{value, score}]` 对象数组,以及
 * 数对 `[[member, score]]`(单测/旧契约)。对象形状优先取 `value`/`score`
 * 键,缺省回退 `member`/`score`。
 * @param type - key 的 Redis 类型。
 * @param value - get_value 返回的结构化值。
 * @returns 字段行数组。
 */
export function rowsFromValue(type: string, value: unknown): FieldRow[] {
  if (type === 'string' || value === null || value === undefined) return []
  if (Array.isArray(value)) {
    if (type === 'list') {
      return (value as unknown[]).map((item, index) => ({
        field: String(index), value: toCell(item), originalField: String(index), originalValue: toCell(item), deleted: false,
      }))
    }
    // stream 只读视图:条目 ID 作 field,字段表 JSON 化作 value(不可编辑)。
    if (type === 'stream') {
      return (value as unknown[]).map((item) => {
        const obj = (item !== null && typeof item === 'object' ? item : {}) as Record<string, unknown>
        const id = toCell(obj.ID ?? obj.id)
        const fields = toCell(obj.Values ?? obj.values)
        return { field: id, value: fields, originalField: id, originalValue: fields, deleted: false }
      })
    }
    return (value as unknown[]).map((item) => {
      // zset 对象形状 {value, score}:成员走 value 键,分数走 score 键。
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>
        const member = obj.value ?? obj.member
        const score = obj.score
        return {
          field: toCell(member), value: toCell(score),
          originalField: toCell(member), originalValue: toCell(score), deleted: false,
        }
      }
      const pair = Array.isArray(item) ? item : [item, '']
      return {
        field: toCell(pair[0]), value: toCell(pair[1]), originalField: toCell(pair[0]), originalValue: toCell(pair[1]), deleted: false,
      }
    })
  }
  return Object.entries(value as Record<string, unknown>).map(([field, v]) => ({
    field, value: toCell(v), originalField: field, originalValue: toCell(v), deleted: false,
  }))
}

/**
 * 检测 string 值是否为合法 JSON 对象/数组,是则返回 pretty-print 文本。
 * 纯量 JSON(数字/字符串/null)不算——对它们做「格式化」没有信息量。
 * @param text - 原始文本。
 * @returns 缩进 2 格的格式化文本;非 JSON 或非对象/数组时返回 null。
 */
export function tryFormatJson(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

/** 值编辑器入参:工作台按当前打开的 key 传入,切换 key 时以 React key 重挂载。 */
export interface RedisValueEditorProps {
  connId: string
  /** 当前打开的完整 key 名。 */
  redisKey: string
  /** key 的 Redis 类型(string/hash/list/set/zset/stream)。 */
  keyType: string
  /** 「添加成员」焦点 nonce:工作台右键菜单打开 key 时 +1,编辑器聚焦新增输入行。 */
  focusAddOnMount?: boolean
  /** 保存成功后的回调(工作台据此刷新键列表与 db 键数);缺省不通知。 */
  onSaved?: () => void
}

const EMPTY_MODEL: KeyModel = { loading: true, saving: false, error: '', type: '', text: '', originalText: '', rows: [] }

/**
 * TTL 数字 → 输入框显示串(负数表示持久化)。
 * @param ttl - key 剩余秒数。
 * @returns 输入显示串。
 */
export function ttlToInput(ttl: number): string {
  return ttl < 0 ? '' : String(ttl)
}

/**
 * 解析 TTL 输入:空串与 `0` 一律归一为「持久化」(null)。
 *
 * Redis 的 `EXPIRE key 0` 是「立即删除 key」,把 0 当「即将过期」下发会在
 * 保存时静默删掉 key,因此 0 与空串同样按持久化处理。
 * @param input - TTL 输入框原始文本。
 * @returns null = 持久化;正整数 = 秒数;'invalid' = 非法输入。
 */
export function parseTtlInput(input: string): number | null | 'invalid' {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 'invalid'
  return n === 0 ? null : n
}

/**
 * TTL 秒数 → 人类可读描述(信息条展示)。
 * @param ttl - key 剩余秒数(负数 = 持久化)。
 * @returns 描述串。
 */
export function humanizeTtl(ttl: number): string {
  if (ttl < 0) return '持久化'
  if (ttl < 60) return `${ttl} 秒`
  if (ttl < 3600) return `${Math.floor(ttl / 60)} 分 ${ttl % 60} 秒`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)} 时 ${Math.floor((ttl % 3600) / 60)} 分`
  return `${Math.floor(ttl / 86400)} 天 ${Math.floor((ttl % 86400) / 3600)} 时`
}

/** 结构类型字段占位符方案:set 单成员列;zset 成员+分数;list 索引+值;hash 字段+值。 */
export function fieldPlaceholders(type: string): { field: string; value: string; single: boolean } {
  if (type === 'set') return { field: '成员', value: '', single: true }
  if (type === 'zset') return { field: '成员', value: '分数', single: false }
  if (type === 'list') return { field: '索引', value: '值', single: false }
  return { field: '字段', value: '值', single: false }
}

/**
 * Render the Redis value editor for one key (string + structural types).
 * @param props - connection id + the open key, its type, and an optional
 *   save-completed callback.
 * @returns the editor for the given key.
 */
export function RedisValueEditor({ connId, redisKey, keyType, focusAddOnMount, onSaved }: RedisValueEditorProps) {
  const [model, setModel] = useState<KeyModel>(EMPTY_MODEL)
  const [ttl, setTtl] = useState<{ ttl: number; ttlInput: string }>({ ttl: -1, ttlInput: '' })
  /** 重试序号:加载失败后 bump 触发重新拉取(旧版只置 loading,不重拉,会卡死在加载态)。 */
  const [generation, setGeneration] = useState(0)
  /** 保存完成后的提示(如「集合已空,key 被 Redis 移除」)。 */
  const [savedNote, setSavedNote] = useState('')
  /** string 值为合法 JSON 时的「格式化」只读视图开关(编辑/保存始终基于原文)。 */
  const [jsonFormatted, setJsonFormatted] = useState(false)
  const saveButtonRef = useRef<HTMLButtonElement>(null)

  /** 生效类型:服务端 get_value 为准;加载中退回 SCAN 传入的 keyType。 */
  const modelType = model.type === '' ? keyType : model.type
  const isString = modelType === 'string'
  /** stream 只读:GetValue 回传条目(ID + 字段表),编辑/写回暂不支持(XADD/XDEL
   *  属于另一套交互),保存只应用 TTL 变更。 */
  const isStream = modelType === 'stream'
  /** string 值的 JSON pretty-print(非合法 JSON 对象/数组时为 null,不展示切换)。 */
  const formattedJson = isString ? tryFormatJson(model.text) : null
  /** key 在打开前已被删除/过期(get_value 返回 type=none)。 */
  const missing = model.type === 'none'
  /** 已加载的原始条目数(不含新增行)。 */
  const loadedCount = model.rows.filter(r => r.originalField !== '').length
  /** 是否已拿到完整集合(size 未知时按完整处理)。 */
  const completeCollection = model.size === undefined || loadedCount >= model.size
  /**
   * 大集合只回传前 N 项:提示用户未加载部分不会被保存覆盖(空串 = 不显示)。
   */
  const sampledLabel = !isString && !missing && !completeCollection && model.size !== undefined
    ? `仅加载前 ${loadedCount} 项(共 ${model.size} 项)`
    : ''

  // key 切换(重挂载或 props 变化)/ 重试 → 重新拉值与 TTL。
  useEffect(() => {
    let cancelled = false
    setModel(EMPTY_MODEL)
    setSavedNote('')
    setJsonFormatted(false)
    redisGetValue(connId, redisKey)
      .then((result) => {
        /* v8 ignore next -- 防御:key 快速切换卸载竞态,取消后丢弃过期响应 */
        if (cancelled) return
        // 以服务端类型为准:SCAN 缓存的 type 可能已过期(key 被删/改类型)。
        const serverType = typeof result.type === 'string' && result.type !== '' ? result.type : keyType
        const str = serverType === 'string'
        const textValue = str && typeof result.value === 'string'
          ? result.value
          : (str ? JSON.stringify(result.value, null, 2) : '')
        const structural = serverType !== 'string' && serverType !== 'none'
        setModel({
          loading: false, saving: false, error: '', type: serverType, text: textValue, originalText: textValue,
          rows: rowsFromValue(serverType, result.value),
          ...(structural && typeof result.size === 'number' ? { size: result.size } : {}),
        })
        setTtl({ ttl: result.ttl, ttlInput: ttlToInput(result.ttl) })
      })
      .catch((e: unknown) => {
        /* v8 ignore next -- 防御:key 快速切换卸载竞态,取消后丢弃过期错误 */
        if (cancelled) return
        setModel({ ...EMPTY_MODEL, loading: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => { cancelled = true }
  }, [connId, redisKey, keyType, generation])

  const updateModel = (patch: Partial<KeyModel>): void => {
    setModel(cur => ({ ...cur, ...patch }))
  }

  /** TTL 是否被改动:输入清空 = 想清除既有 TTL(仅当当前有 TTL 才算改动)。 */
  const ttlDirty = ttl.ttlInput === '' ? ttl.ttl >= 0 : parseTtlInput(ttl.ttlInput) !== ttl.ttl

  const dirty = isString
    ? model.text !== model.originalText || ttlDirty
    : isStream
      ? ttlDirty
      : model.rows.some(r => r.deleted || r.field !== r.originalField || r.value !== r.originalValue) || ttlDirty

  /**
   * 保存后集合是否会被清空(Redis 对空集合自动移除 key)。仅当原本有成员、
   * 且保存后一个不剩时成立——新建的空 key 不受影响。
   */
  const willEmptyCollection = useMemo(() => {
    if (isString || isStream) return false
    // 只加载了前 N 项的大集合:删完可见项并不会清空 key,不能误报。
    if (!completeCollection) return false
    const hadOriginal = model.rows.some(r => r.originalField !== '')
    const keepsAny = model.rows.some(r => !r.deleted)
    return hadOriginal && !keepsAny
  }, [isString, model.rows, completeCollection])

  const copyKey = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(redisKey)
    } catch {
      /* 剪贴板不可用(非安全上下文/权限拒绝)时静默失败,不打断编辑流。 */
    }
  }

  const save = async (): Promise<void> => {
    updateModel({ saving: true, error: '' })
    setSavedNote('')
    try {
      const expiration = parseTtlInput(ttl.ttlInput)
      if (expiration === 'invalid') {
        updateModel({ saving: false, error: 'TTL 必须是 ≥ 0 的整数(秒),0 表示持久化' })
        return
      }
      if (isString) {
        // SET 不带 EX 会同时清除既有 TTL:同步本地态,避免 UI 与服务端漂移。
        await redisSet(connId, redisKey, model.text, expiration ?? undefined)
        if (expiration !== null) setTtl({ ttl: expiration, ttlInput: String(expiration) })
        else if (ttl.ttl >= 0) setTtl({ ttl: -1, ttlInput: '' })
      } else {
        // stream 只读:没有结构写回(旧版会把条目映射成空行、保存静默无效),
        // 仅应用 TTL 变更。
        if (!isStream) await saveStructural(model.rows, modelType, redisKey, connId)
        // 结构类型的写回不带 TTL 语义:显式下发 EXPIRE(或清空时 PERSIST),
        // 成功后才更新本地 TTL 态(旧版乐观置位,实际从未下发)。
        // 注意:绝不下发 `EXPIRE key 0`——那会立即删除 key。
        if (expiration !== null) {
          await runCommand(connId, `EXPIRE ${redisQuote(redisKey)} ${expiration}`)
          setTtl({ ttl: expiration, ttlInput: String(expiration) })
        } else if (ttl.ttl >= 0) {
          await runCommand(connId, `PERSIST ${redisQuote(redisKey)}`)
          setTtl({ ttl: -1, ttlInput: '' })
        }
      }
      // 保存后条目数按「删除 −1、新增 +1」推进(改名是删旧+建新,净变化 0),
      // 让「仅加载前 N 项」的提示继续成立。
      const originalRows = model.rows.filter(r => r.originalField !== '')
      const deletedCount = originalRows.filter(r => r.deleted).length
      const addedCount = model.rows.filter(r => !r.deleted && r.originalField === '').length
      const nextSize = !isString && model.size !== undefined
        ? Math.max(0, model.size - deletedCount + addedCount)
        : undefined
      updateModel({
        saving: false, originalText: model.text,
        rows: model.rows.filter(r => !r.deleted).map(r => ({ ...r, originalField: r.field, originalValue: r.value, deleted: false })),
        ...(nextSize !== undefined ? { size: nextSize } : {}),
      })
      if (willEmptyCollection) {
        setSavedNote('所有成员已删除,Redis 已自动移除该 key')
      }
      onSaved?.()
    } catch (e: unknown) {
      updateModel({ saving: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className={css.editor}>
      <div className={css.infoBar}>
        <div className={css.infoLeft}>
          <span className={`${css.typeBadge} ${css[`type_${modelType}`] ?? ''}`}>{modelType.toUpperCase()}</span>
          <span className={css.infoKey} title={redisKey}>{redisKey}</span>
          <button type="button" className={css.copyKey} title="复制 key 名" aria-label="复制 key 名"
            onClick={() => void copyKey()}><IconCopyOutlineMedium size={12} /></button>
        </div>
        <div className={css.infoRight}>
          <span className={css.ttlText}
            title={missing ? 'key 不存在' : ttl.ttl < 0 ? '该 key 持久化' : `剩余 ${ttl.ttl} 秒`}>
            {missing ? '—' : humanizeTtl(ttl.ttl)}
          </span>
          <label className={css.ttlLabel}>
            TTL
            <input className={css.ttlInput} value={ttl.ttlInput} placeholder={missing ? '—' : ttl.ttl < 0 ? '持久化' : String(ttl.ttl)} type="number"
              disabled={model.loading || missing} aria-label="TTL 秒数"
              onChange={(e) =>{  setTtl(cur => ({ ...cur, ttlInput: e.target.value })) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && dirty && !model.saving) void save() }} />
          </label>
        </div>
      </div>

      {model.loading && <div className={css.center}>加载中…</div>}

      {!model.loading && model.error !== '' && (
        <div className={css.center}>
          <div className={css.errorText}>{model.error}</div>
          <button type="button" className={css.secondaryButton}
            onClick={() =>{  setGeneration(g => g + 1) }}>重试</button>
        </div>
      )}

      {!model.loading && model.error === '' && missing && (
        <div className={css.center}>
          <div className={css.errorText}>Key 不存在(可能已过期或在别处被删除)</div>
          <button type="button" className={css.secondaryButton}
            onClick={() =>{  setGeneration(g => g + 1) }}>重试</button>
        </div>
      )}

      {!model.loading && model.error === '' && !missing && (
        isString
          ? (
            <>
              {formattedJson !== null && (
                <div className={css.jsonBar}>
                  <button type="button" aria-label="原文视图"
                    className={jsonFormatted ? css.jsonToggle : css.jsonToggleActive}
                    onClick={() =>{  setJsonFormatted(false) }}>原文</button>
                  <button type="button" aria-label="格式化视图"
                    className={jsonFormatted ? css.jsonToggleActive : css.jsonToggle}
                    onClick={() =>{  setJsonFormatted(true) }}>格式化</button>
                </div>
              )}
              {jsonFormatted && formattedJson !== null ? (
                // 只读展示:编辑与保存始终基于原文,格式化产物不回写。
                <pre className={css.jsonView} data-testid="redis-json-view">{formattedJson}</pre>
              ) : (
                <textarea className={css.area} value={model.text} spellCheck={false} placeholder="值…"
                  onChange={(e) =>{  updateModel({ text: e.target.value }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && dirty && !model.saving) void save() }} />
              )}
            </>
          )
          : isStream
            ? (
              <StreamRows rows={model.rows} />
            )
            : (
              <StructuralRows rows={model.rows} type={modelType}
                {...(focusAddOnMount === true ? { focusAdd: true } : {})}
                onChange={(rows) =>{  updateModel({ rows }) }} />
            )
      )}

      <div className={css.footer}>
        {sampledLabel !== '' && (
          <span className={css.hint} title="大集合只加载前若干项;保存只应用本页的增删改,未加载成员保持原样">
            {sampledLabel}
          </span>
        )}
        {isStream && (
          <span className={css.hint} title="stream 的条目增删改请用 CLI(XADD / XDEL / XTRIM)">stream 只读 · 仅 TTL 可修改</span>
        )}
        {willEmptyCollection && dirty && (
          <span className={css.footerWarn}>保存后集合为空,Redis 将自动删除该 key</span>
        )}
        {model.error !== '' && <span className={css.footerError}>{model.error}</span>}
        {savedNote !== '' && <span className={css.footerNote}>{savedNote}</span>}
        <span className={css.spacer} />
        <span className={css.hint}>Mod+Enter 保存</span>
        <button type="button" className={css.secondaryButton} disabled={!dirty}
          onClick={() =>{  updateModel(isString ? { text: model.originalText } : { rows: revertRows(model.rows) }) }}>
          还原
        </button>
        <button ref={saveButtonRef} type="button" className={css.primaryButton} disabled={!dirty || model.saving} onClick={() => void save()}>
          {model.saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

/** 还原结构行:去掉删除标记并回填原始字段/值(空串原值也必须还原,不能用 `||`)。 */
function revertRows(rows: FieldRow[]): FieldRow[] {
  return rows
    .filter(r => r.originalField !== '' || !r.deleted)
    .map(r => ({
      ...r,
      field: r.originalField === '' ? r.field : r.originalField,
      value: r.originalValue === '' ? (r.originalField === '' ? r.value : r.originalValue) : r.originalValue,
      deleted: false,
    }))
}

/** 提交结构类型增删改:list 走专用 saveList(哨兵值按索引删);其余先按 verb 批量删(含改名旧成员),再按类型写回。 */
async function saveStructural(rows: FieldRow[], type: string, key: string, connId: string): Promise<void> {
  if (type === 'list') {
    await saveList(rows, key, connId)
    return
  }
  const toDelete = rows.filter(r => r.deleted && r.originalField !== '')
  const toSet = rows.filter(r => !r.deleted && (r.field !== r.originalField || r.value !== r.originalValue || r.originalField === ''))
  // 改名 = 删旧成员 + 增新成员;只增不删会残留旧值。
  const renamed = toSet.filter(r => r.originalField !== '' && r.field !== r.originalField)
  const delTargets = [...toDelete.map(r => r.originalField), ...renamed.map(r => r.originalField)]
  if (delTargets.length > 0) {
    const args = delTargets.map(r => redisQuote(r)).join(' ')
    await runCommand(connId, `${delVerb(type)} ${redisQuote(key)} ${args}`)
  }
  if (toSet.length > 0) {
    if (type === 'hash') {
      const kv = toSet.flatMap(r => [redisQuote(r.field), redisQuote(r.value)]).join(' ')
      await runCommand(connId, `HSET ${redisQuote(key)} ${kv}`)
    } else if (type === 'set') {
      const members = toSet.map(r => redisQuote(r.field)).join(' ')
      await runCommand(connId, `SADD ${redisQuote(key)} ${members}`)
    } else if (type === 'zset') {
      const members = toSet.map(r => `${redisQuote(r.value)} ${redisQuote(r.field)}`).join(' ')
      await runCommand(connId, `ZADD ${redisQuote(key)} ${members}`)
    }
  }
}

/** 生成一次保存内唯一的哨兵值(仅本进程本次保存用到,碰撞概率可忽略)。 */
function makeSentinel(): string {
  return `__starthub_list_del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`
}

/**
 * 提交 list 增删改。
 *
 * 删除按**索引**而非值:list 允许重复值,`LREM key 1 <value>` 会删到第一个
 * 值匹配的元素,标记的索引可能幸存而别的实例被删。改为两步——先把每个待删
 * 索引 LSET 成唯一哨兵值,再 `LREM key 0 <哨兵>` 一次清掉,删除精确落在
 * 标记的索引上。删除会使后续元素索引前移:既有行的 LSET 目标索引 = 原索引
 * − 之前已删行数(重算)。新增行(无原索引)RPUSH 追加。
 * @param rows - 当前全量行(含删除标记)。
 * @param key - 目标 key。
 * @param connId - 连接 id。
 */
async function saveList(rows: FieldRow[], key: string, connId: string): Promise<void> {
  const toDelete = rows.filter(r => r.deleted && r.originalField !== '')
  const toSet = rows.filter(r => !r.deleted && (r.value !== r.originalValue || r.originalField === ''))
  const deletedIdx = toDelete.map(r => Number(r.originalField))
  if (toDelete.length > 0) {
    // 第一步:待删索引改写成哨兵(LSET 按索引,不移位)。
    const sentinel = makeSentinel()
    for (const r of toDelete) {
      await runCommand(connId, `LSET ${redisQuote(key)} ${r.originalField} ${redisQuote(sentinel)}`)
    }
    // 第二步:一次清掉全部哨兵实例。
    await runCommand(connId, `LREM ${redisQuote(key)} 0 ${redisQuote(sentinel)}`)
  }
  for (const r of toSet) {
    if (r.originalField === '') {
      await runCommand(connId, `RPUSH ${redisQuote(key)} ${redisQuote(r.value)}`)
      continue
    }
    const origIdx = Number(r.originalField)
    let shift = 0
    for (const d of deletedIdx) if (d < origIdx) shift += 1
    await runCommand(connId, `LSET ${redisQuote(key)} ${origIdx - shift} ${redisQuote(r.value)}`)
  }
}

/** 结构类型删除成员的 verb。 */
export function delVerb(type: string): string {
  if (type === 'hash') return 'HDEL'
  if (type === 'set') return 'SREM'
  if (type === 'zset') return 'ZREM'
  return 'LREM'
}

/** 执行命令,res.error 即抛错。 */
async function runCommand(connId: string, command: string): Promise<void> {
  const res: RedisCommandResult = await redisExecute(connId, command)
  if (res.error) throw new Error(res.error)
}

/** 结构类型字段表(hash/list/set/zset 共用);带成员筛选(仅过滤展示,保存仍走全量行)。
 *
 * 「新增成员」行**置顶并随滚动常驻**(sticky):旧版在表格最底部,成员多的集合
 * 要滚到底才能加一项;输入框回车即添加并清空(焦点留在输入框,可连续追加),
 * 右键菜单的「添加成员」经 addFocusNonce 把焦点直接送到这里。 */
function StructuralRows({ rows, type, onChange, focusAdd }: {
  rows: FieldRow[]
  type: string
  onChange: (rows: FieldRow[]) => void
  /** 挂载即聚焦新增行(右键「添加成员」打开 key 时)。 */
  focusAdd?: boolean
}) {
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')
  const [filter, setFilter] = useState('')
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const valueRef = useRef<HTMLInputElement | null>(null)
  const ph = fieldPlaceholders(type)
  // 筛选只决定可见性:apply 用原始下标回写全量 rows,过滤态编辑不错位。
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => term === '' || row.field.toLowerCase().includes(term) || row.value.toLowerCase().includes(term))
  }, [rows, filter])
  const apply = (index: number, patch: Partial<FieldRow>) => {
    onChange(rows.map((r, i) => i === index ? { ...r, ...patch } : r))
  }
  const add = (): boolean => {
    // 必填项:set/list 新增只有值输入;hash/zset 必须有字段(成员)名。
    const needed = ph.single || type === 'list' ? newValue.trim() : newField.trim()
    /* v8 ignore next -- 新增按钮在必填输入空白时 disabled,空名早退分支不可达 */
    if (needed === '') return false
    // list 新增行只有值(RPUSH 追加,索引由服务端分配);set 单列成员;其余 field+value。
    const row: FieldRow = type === 'list'
      ? { field: '', value: newValue, originalField: '', originalValue: '', deleted: false }
      : ph.single
        ? { field: newValue.trim(), value: '', originalField: '', originalValue: '', deleted: false }
        : { field: newField.trim(), value: newValue, originalField: '', originalValue: '', deleted: false }
    onChange([...rows, row])
    setNewField('')
    setNewValue('')
    return true
  }
  const addDisabled = ph.single || type === 'list' ? newValue.trim() === '' : newField.trim() === ''
  /** 回车 = 添加并把焦点还给首个可编辑输入框(连续追加)。 */
  const onAddKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (add()) {
      const target = ph.single || type === 'list' ? valueRef.current : fieldRef.current
      target?.focus()
    }
  }
  // 右键「添加成员」:挂载即聚焦新增行首个输入框(focusAdd 只在本次挂载为
  // true 时生效;普通点击打开不抢焦点)。
  useEffect(() => {
    if (focusAdd !== true) return
    const target = ph.single || type === 'list' ? valueRef.current : fieldRef.current
    target?.focus()
    // ph.single/type 在同一 key 的编辑器实例内恒定,不列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className={css.table}>
      {/* 新增行置顶(sticky):成员多时不必滚到底部。 */}
      <div className={css.newRowSticky}>
        {!(ph.single || type === 'list') && (
          <input ref={fieldRef} className={css.cellField} placeholder={`新${ph.field}`} spellCheck={false} aria-label={`新${ph.field}`}
            title="回车快速添加,可连续追加"
            value={newField} onChange={(e) =>{  setNewField(e.target.value) }}
            onKeyDown={onAddKeyDown} />
        )}
        <input ref={valueRef} className={css.cellValue} placeholder={ph.single ? '新成员' : type === 'list' ? '新值(RPUSH 追加)' : `新${ph.value}`}
          spellCheck={false} aria-label="新值"
          title="回车快速添加,可连续追加"
          value={newValue} onChange={(e) =>{  setNewValue(e.target.value) }}
          onKeyDown={onAddKeyDown} />
        <button type="button" className={css.addButton} title="新增" aria-label="新增" disabled={addDisabled} onClick={add}><IconPlusOutlineMedium size={13} /></button>
      </div>
      <div className={css.filterRow}>
        <input className={css.filterInput} value={filter} aria-label="筛选成员" spellCheck={false}
          placeholder={`筛选成员…(共 ${rows.length} 条)`}
          onChange={(e) =>{  setFilter(e.target.value) }} />
        {filter !== '' && (
          <button type="button" className={css.filterClear} aria-label="清除筛选" title="清除筛选"
            onClick={() =>{  setFilter('') }}><IconCloseOutlineMedium size={12} /></button>
        )}
      </div>
      <div className={css.tableBody}>
        {visible.map(({ row: r, index }) => (
          <div className={`${css.row} ${r.deleted ? css.rowDeleted : ''}`} key={`${index}-${r.originalField}`}>
            {type !== 'list' || r.originalField !== '' ? (
              ph.single ? (
                <input className={`${css.cellField} ${css.cellMember}`} value={r.field} disabled={r.deleted} placeholder={ph.field} spellCheck={false}
                  onChange={(e) =>{  apply(index, { field: e.target.value }) }} />
              ) : (
                <>
                  <input className={css.cellField} value={r.field} disabled={r.deleted || type === 'list'} placeholder={ph.field} spellCheck={false}
                    onChange={(e) =>{  apply(index, { field: e.target.value }) }} />
                  <input className={css.cellValue} value={r.value} disabled={r.deleted} placeholder={ph.value} spellCheck={false}
                    onChange={(e) =>{  apply(index, { value: e.target.value }) }} />
                </>
              )
            ) : (
              <input className={`${css.cellValue} ${css.cellMember}`} value={r.value} disabled={r.deleted} placeholder="值" spellCheck={false}
                onChange={(e) =>{  apply(index, { value: e.target.value }) }} />
            )}
            <button type="button" className={css.delButton} title={r.deleted ? '撤销删除' : '删除'}
              onClick={() =>{  apply(index, { deleted: !r.deleted }) }}>
              {r.deleted ? <IconRefreshOutlineMedium size={12} /> : <IconCloseFillMedium size={12} />}
            </button>
          </div>
        ))}
        {visible.length === 0 && (
          <div className={css.noMatch}>{rows.length === 0 ? '暂无成员' : '无匹配成员'}</div>
        )}
      </div>
    </div>
  )
}

/** stream 只读视图:条目 ID + 字段表(JSON)。增删改请走 CLI(XADD/XDEL/XTRIM)——
 *  旧版把条目映射成空 field/value 行、保存静默无效,现在明确只读。 */
function StreamRows({ rows }: { rows: FieldRow[] }) {
  return (
    <div className={css.table}>
      <div className={css.streamHint}>stream 为只读视图:仅展示已加载的条目(ID + 字段);增删改请用 CLI(XADD / XDEL / XTRIM)。</div>
      <div className={css.tableBody}>
        {rows.map((r, index) => (
          <div className={css.row} key={`${index}-${r.field}`}>
            <span className={css.streamId} title={r.field}>{r.field}</span>
            <span className={css.streamFields} title={r.value}>{r.value}</span>
          </div>
        ))}
        {rows.length === 0 && <div className={css.noMatch}>暂无条目</div>}
      </div>
    </div>
  )
}
