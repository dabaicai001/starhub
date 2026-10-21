/**
 * StarHub 原生 Redis 工作台(批次 2:Redis 工作台 React 化)。
 * 壳内全屏 overlay,替换 Vue embed RedisView。挂载按 asset.config 连
 * db_redis_connect,卸载断连。
 *
 * 左侧为 **DB 树**:db0–db15 全部默认收起,点击某个 db 才展开并懒加载
 * (db_redis_select 把客户端切换到该库,再 db_redis_db_size + db_redis_scan
 * 取该 db 的键)。键加载经 redisScanAccumulate 连续分页直到游标归零(单批
 * 上限 SCAN_BATCH_LIMIT,超过后展示「加载更多」按游标续传),解决大 db 只展示
 * 首页 SCAN(~百条)的问题;加载中展示「已加载 / 总数」进度。键按 ':' 二次分组
 * 为文件夹树,文件夹同样默认收起,点击该行才展开叶子。同一时刻只展开一个
 * db——sidecar 的 Redis 客户端是单库语义(Select 即重建连接),展开态 db 恒等于
 * 客户端当前 db,键操作(打开/重命名/删除/清空/新建)与 CLI(db_redis_execute)
 * 都作用在展开的库上。已加载的键按 db 缓存,收起再展开不重复请求(部分加载的
 * 缓存命中时自动续传一批)。
 *
 * v0.102.0:
 * - **搜索移到每个展开的 db 区块内**(per-db 搜索词,互不影响),输入经 350ms
 *   防抖自动重扫该 db(旧版全局搜索框只写 state、从不触发重扫,等于失效);
 *   不含 glob 字符(* ? [ ])的词自动包成 `*词*` 子串匹配,含 glob 字符原样透传。
 * - **修复不能切换 key**:旧版经 openRef 回调打开,openRef 只在编辑器挂载
 *   effect 里捕获一次,openValue 从 key A 换成 key B 时编辑器不重挂载、永远
 *   停在 A;现在 RedisValueEditor 改为受控 props(redisKey/keyType)并以
 *   React key 按 key 重挂载。
 *
 * P0 修复(库漂移):CLI 的 SELECT 不透传给 sidecar 执行(持久连接会真实切库而
 * UI 状态不跟随,后续 FLUSHDB/删除会作用在看不见的库上),改为走 redisSelect RPC
 * 并同步 activeDb/expandedDb 与键列表;FLUSHDB 执行前先显式 select 目标库,且确认
 * 弹窗要求输入 db 序号二次确认(替代 window.confirm)。
 *
 * v0.137.0 交互重构:
 * - **键行补 TTL 徽标**:SCAN 已带回 ttl,旧版丢弃不用,用户无法分辨哪些 key
 *   即将过期;现在 -1 显示「∞」、其余显示剩余秒数(超 1 小时折算为小时)。
 * - **键行补复制钮**:hover 出现,点击复制完整 key 名(此前只能手动选中文本)。
 * - **CLI 补历史**:上下方向键翻阅本次会话执行过的命令(旧版无历史,重复命令
 *   只能重打)。
 * - **值编辑器保存后回调刷新**:编辑器经 onSaved 通知,工作台重拉该 db 的键与
 *   键数,避免「保存成功但左侧树/头部计数还是旧值」的漂移。
 * - **空态/错误态文案明确化**:区分「暂无 key」「加载失败」「搜索无结果」。
 *
 * v0.136.6:
 * - **连接失败补「重试」**:错误条旧版只有「返回」,连不上只能关窗重开;现在
 *   原地重建连接。
 * - **键树 React key 去重**:key `a` 与同名文件夹 `a`(来自 key `a:b`)的 path
 *   相同,渲染 key 加节点种类前缀,避免重复 key 让协调器复用错行。
 *
 * 本轮增强:
 * - **建连采纳资产配置的初始库**:`asset.config.db` 为 0-15 整数时直接连到该库
 *   并同步 activeDb(旧版硬编码 db0,库与 UI 状态漂移)。
 * - **per-db 类型过滤**:搜索行右侧下拉(全部/string/hash/list/set/zset),按 db
 *   隔离持久;选中具体类型时该 db 改走 db_redis_scan_all(服务端过滤的一次性
 *   全量,无「加载更多」),「全部」维持 redisScanAccumulate 分页。
 * - **批量删除**:key 叶子行与文件夹行加勾选框(文件夹 = 其下全部叶子),工具栏
 *   「删除所选 (N)」一次 db_redis_del 提交;键列表重扫即清空勾选(重扫结果可能
 *   已变,保留旧勾选会删掉看不见的 key)。
 * - **右侧主区「键值 / 分析」页签**:分析页(见 RedisAnalysisPanel)含服务器
 *   信息、慢日志、BigKey 扫描、内存分析四块。
 * - **新建 key 支持 TTL**:string 拼 `SET k v EX ttl`,其它类型创建后补 EXPIRE。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutlineMedium, IconChevronRightOutlineMedium, IconCloseFillMedium, IconCloseOutlineMedium,
  IconCodeOutlineMedium, IconCopyOutlineMedium, IconEditOutlineMedium, IconPlusOutlineMedium, IconTrashOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RustAsset } from '../store.ts'
import { redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB, redisGetValue, redisQuote, redisRename, redisScan, redisScanAccumulate, redisScanAll, redisSelect, type RedisKeyInfo } from './redis-service.ts'
import { allFolderPaths, buildKeyTree, countLeaves, leafKeys, type KeyTreeNode } from './key-tree.ts'
import { RedisValueEditor } from './RedisValueEditor.tsx'
import { RedisAnalysisPanel } from './RedisAnalysisPanel.tsx'
import { ContextMenu, useContextMenu } from '../ContextMenu.tsx'
import css from './RedisWorkbench.module.css'

/** Redis 固定 DB 编号(单机 0-15)。 */
const DB_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/** 单批连续 SCAN 的 key 总量上限:超过则停在 batch 末尾,由「加载更多」续传。 */
const SCAN_BATCH_LIMIT = 10_000

/** 搜索输入防抖:停敲 350ms 后自动按新匹配重扫展开的 db。 */
const SEARCH_DEBOUNCE_MS = 350

/** CLI 历史上限(防无界增长)。 */
const CLI_HISTORY_LIMIT = 100

/**
 * 搜索词 → SCAN MATCH 模式:含 glob 字符(* ? [ ])原样透传(用户自定义模式),
 * 否则包成 `*词*` 子串匹配(符合「搜索」直觉,避免裸词只匹配完整 key)。
 * @param term - 用户输入(已 trim)。
 * @returns MATCH 模式;空串表示不过滤。
 */
export function toScanMatch(term: string): string {
  if (term === '') return ''
  return /[*?[\]]/.test(term) ? term : `*${term}*`
}

/**
 * 解析 CLI 输入的 SELECT 目标库。
 * @param command - CLI 原始输入(未 trim 也可)。
 * @returns 非 SELECT 命令返回 null;合法 SELECT 返回目标 db(0-15);SELECT 但参数
 *   缺失/非法返回 'invalid'。
 */
export function parseCliSelect(command: string): number | 'invalid' | null {
  const tokens = command.trim().split(/\s+/).filter(t => t !== '')
  const first = tokens[0]
  if (first === undefined || first.toLowerCase() !== 'select') return null
  if (tokens.length !== 2) return 'invalid'
  const db = Number(tokens[1])
  if (!Number.isInteger(db) || db < 0 || db > 15) return 'invalid'
  return db
}

/**
 * key 剩余 TTL → 键行徽标文本。-1(持久化)显示「∞」,超 1 小时折算小时,
 * 否则原样秒数。ttl 缺省(SCAN 未带回)时返回空串,不渲染徽标。
 * @param ttl - key 剩余秒数。
 * @returns 徽标文本;无需展示时返回 ''。
 */
export function ttlBadge(ttl: number | undefined): string {
  if (ttl === undefined) return ''
  if (ttl < 0) return '∞'
  if (ttl >= 3600) return `${Math.floor(ttl / 3600)}h`
  return String(ttl)
}

/** 单个 db 的懒加载缓存:展开时取一次,收起保留。 */
interface DbLoadable {
  keys: RedisKeyInfo[]
  cursor: number
  /** SCAN 游标是否已归零(false = 还有未加载的键,可「加载更多」续传)。 */
  complete: boolean
  loading: boolean
  error: string | null
  /** DBSIZE 键总数(展开时与 SCAN 一起刷新)。 */
  size: number
  /** 本次加载使用的搜索匹配模式(缓存命中判定用);null = 从未加载过键——
      新建 key/FLUSHDB 后只刷新 size 会基于 EMPTY 建出「有 size 无键」的占位
      记录,若 match 也是 '' 会被 toggleDb 误判为完整缓存而跳过加载(展开后
      显示「暂无 key」),故未加载恒为 null,命中判定天然失败。 */
  match: string | null
  /** 本次加载使用的类型过滤('' = 全部);null = 从未加载过键(与 match 同理)。 */
  typeFilter: string | null
}

/** 未加载 db 的占位记录(patchDbList 的合并基底)。 */
const EMPTY_DB_LOADABLE: DbLoadable = {
  keys: [], cursor: 0, complete: true, loading: false, error: null, size: 0, match: null, typeFilter: null,
}

/** 无展开文件夹的占位集(toggleKeyFolder 从不原地改动,可安全共享)。 */
const EMPTY_FOLDER_PATHS: ReadonlySet<string> = new Set()

/** 无勾选的占位集(勾选操作从不原地改动,可安全共享)。 */
const EMPTY_SELECTED: ReadonlySet<string> = new Set()

/** 新建 key 支持的类型。 */
export const NEW_KEY_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const

/** per-db 类型过滤可选值:'' = 全部(走分页 SCAN),其余走 scan_all 服务端过滤。 */
export const REDIS_TYPE_FILTERS = ['', 'string', 'hash', 'list', 'set', 'zset', 'stream'] as const

/**
 * 会改变键空间(或 key 元数据)的 Redis 命令动词——CLI 执行后需要重扫所在库。
 * 只读命令(GET/KEYS/HGETALL/TTL/TYPE/SCAN…)不改变键集合,重扫纯属浪费:
 * 大库上一次全库 SCAN 可能数秒,旧版无脑刷新让每条只读命令都卡一遍。
 * @param command - CLI 原始输入(未 trim 也可)。
 * @returns 首个 token 是写操作时 true。
 */
export function isMutatingRedisCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0]
  if (first === undefined) return false
  const verb = first.toUpperCase()
  return MUTATING_REDIS_VERBS.has(verb)
}

/** 写操作动词表(SET/HDEL/XADD/EXPIRE/FLUSHDB…;SELECT 由调用方单独拦截)。 */
const MUTATING_REDIS_VERBS: ReadonlySet<string> = new Set([
  'SET', 'SETEX', 'PSETEX', 'SETNX', 'MSET', 'MSETNX', 'GETSET', 'GETDEL', 'GETEX', 'APPEND',
  'INCR', 'DECR', 'INCRBY', 'DECRBY', 'INCRBYFLOAT',
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST', 'RESTORE', 'MIGRATE', 'COPY', 'MOVE', 'RENAME', 'RENAMENX',
  'HDEL', 'HMSET', 'HSET', 'HSETNX', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LSET', 'LREM', 'LTRIM', 'LINSERT', 'LMOVE', 'RPOPLPUSH',
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'SINTERSTORE', 'SUNIONSTORE', 'SDIFFSTORE',
  'ZADD', 'ZINCRBY', 'ZREM', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYRANK', 'ZREMRANGEBYLEX', 'ZPOPMIN', 'ZPOPMAX', 'ZRANGESTORE',
  'XADD', 'XDEL', 'XTRIM', 'XSETID', 'XGROUP', 'XCLAIM', 'XAUTOCLAIM',
  'PFADD', 'PFMERGE',
  'FLUSHDB', 'FLUSHALL', 'SWAPDB', 'FUNCTION', 'SCRIPT',
])

/**
 * 新建 key 对话框的值输入占位符(按类型说明这一项填什么)。
 * @param type - 选中的 key 类型。
 * @returns 占位符/aria-label 共用的文案。
 */
export function valuePlaceholder(type: string): string {
  if (type === 'string') return '值(string)'
  if (type === 'hash') return '值(hash)'
  if (type === 'stream') return '首条目的字段值'
  if (type === 'zset') return '首个成员'
  return '首个成员'
}

/** 新建 key 对话框输入。 */
interface NewKeyDraft {
  key: string
  type: string
  value: string
  /** 目标 db(打开弹窗时默认当前展开/所在库,可改)。 */
  db: number
  /** hash 的字段名。 */
  field: string
  /** zset 的分值。 */
  score: string
  /** TTL 秒数输入(空 = 持久化;非正整数在创建时拦截,不创建)。 */
  ttl: string
}

/**
 * 解析新建 key 的 TTL 输入:空 = 持久化(null);正整数 = 秒数;其余为 'invalid'。
 * 0/负数必须拒绝:Redis 的 `EXPIRE key 0` 语义是「立即删除 key」,`SET k v EX 0`
 * 是服务端报错,都不符合「新建 key」的预期。
 * @param input - TTL 输入框原始文本。
 * @returns null = 持久化;正整数 = 秒数;'invalid' = 非法输入。
 */
export function parseNewKeyTtl(input: string): number | null | 'invalid' {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n <= 0) return 'invalid'
  return n
}

/** buildCreateKeyCommand 的返回:命令文本 + 解析出的 TTL 秒。 */
export interface CreateKeyCommand {
  command: string
  /** 合法正整数 TTL(秒);无 TTL 为 null(调用方据此决定是否追加 EXPIRE)。 */
  ttl: number | null
}

/**
 * 组装新建 key 的 Redis 命令:按类型分派(hash 用 field+value,zset 用 score+member,
 * list/set 以 value 作首个成员——Redis 不允许创建空集合,必须先写一个元素;
 * stream 用 XADD,服务器分配 id,field+value 即首条目的字段与值)。
 * string 类型带 TTL 时拼成 `SET k v EX ttl`;其它类型的创建命令没有 TTL 语义,
 * TTL 经返回值带出,由调用方在创建成功后追加 `EXPIRE key ttl`。
 * @param draft - 对话框输入(key 已 trim;ttl 需先经 parseNewKeyTtl 校验,此处非法按无 TTL 处理)。
 * @returns 命令与 TTL;hash/stream 缺 field / zset score 非数字时返回 null(调用方提示)。
 */
export function buildCreateKeyCommand(draft: NewKeyDraft): CreateKeyCommand | null {
  const key = redisQuote(draft.key)
  const value = redisQuote(draft.value)
  const ttlParsed = parseNewKeyTtl(draft.ttl)
  const ttl = ttlParsed === 'invalid' ? null : ttlParsed
  switch (draft.type) {
    case 'hash': {
      if (draft.field.trim() === '') return null
      return { command: `HSET ${key} ${redisQuote(draft.field)} ${value}`, ttl }
    }
    case 'list': return { command: `RPUSH ${key} ${value}`, ttl }
    case 'set': return { command: `SADD ${key} ${value}`, ttl }
    case 'stream': {
      if (draft.field.trim() === '') return null
      // `*` = 服务器分配条目 id;field+value 即首条目的一个字段对。
      return { command: `XADD ${key} * ${redisQuote(draft.field)} ${value}`, ttl }
    }
    case 'zset': {
      const score = Number(draft.score)
      if (draft.score.trim() === '' || !Number.isFinite(score)) return null
      return { command: `ZADD ${key} ${score} ${value}`, ttl }
    }
    default: return { command: ttl === null ? `SET ${key} ${value}` : `SET ${key} ${value} EX ${ttl}`, ttl }
  }
}

/** 树行渲染入参:节点 + 深度 + 展开态/勾选集与操作回调。 */
interface KeyTreeRowProps {
  node: KeyTreeNode
  depth: number
  expanded: ReadonlySet<string>
  /** 当前 db 的批量删除勾选集。 */
  selected: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (key: string, type: string) => void
  /** 打开 key 并把焦点落到值编辑器的「新增成员」行(右键快捷添加用)。 */
  onOpenAndAdd: (key: string, type: string) => void
  onCopy: (key: string) => void
  onCopyValue: (key: string) => void
  onRename: (key: string) => void
  onDelete: (key: string) => void
  onToggleSelect: (key: string, checked: boolean) => void
  onToggleFolderSelect: (node: KeyTreeNode, checked: boolean) => void
}

/**
 * 渲染一行键树节点:文件夹行(勾选框 + 箭头 + 段名 + 叶子计数,点击折叠/展开,
 * 子级递归)或叶子行(勾选框 + 类型徽标 + 最后一段 + TTL 徽标,操作沿用完整 key)。
 * 勾选用于批量删除:文件夹勾选 = 其下全部叶子;勾选的叶子行高亮。
 *
 * 右键菜单(与 MySQL 库/表行对齐,旧版键树完全没有右键入口):
 * 叶子行 = 打开 / 复制 key 名 / 复制 value / 添加成员(结构类型)/ 重命名 / 删除;
 * 文件夹行 = 展开|收起 / 复制 key 前缀。
 * @param props - 节点与回调。
 * @returns 该行(及展开时的子级行)。
 */
function KeyTreeRow({
  node, depth, expanded, selected, onToggle, onOpen, onOpenAndAdd, onCopy, onCopyValue, onRename, onDelete, onToggleSelect, onToggleFolderSelect,
}: KeyTreeRowProps) {
  const menu = useContextMenu()
  const indent = { paddingLeft: 5 + depth * 14 }
  if (node.keyInfo !== null) {
    const k = node.keyInfo
    const ttl = ttlBadge(k.ttl)
    const checked = selected.has(k.key)
    const items: readonly MenuEntry[] = [
      { id: 'open', label: '打开' },
      { id: 'copy', label: '复制 key 名' },
      { id: 'copy-value', label: '复制 value' },
      ...(k.type === 'string' ? [] : [{ id: 'add', label: '添加成员' }]),
      { id: 'rename', label: '重命名' },
      { id: 'sep', type: 'separator' },
      { id: 'delete', label: '删除', danger: true },
    ]
    return (
      <div className={`${css.keyRow} ${checked ? css.keyRowSelected : ''}`} style={indent} onContextMenu={menu.onContextMenu}>
        <input type="checkbox" className={css.keyCheck} checked={checked} title="选择"
          aria-label={`选择 ${k.key}`}
          onChange={(e) =>{  onToggleSelect(k.key, e.target.checked) }} />
        <button type="button" className={css.keyMain} onClick={() =>{  onOpen(k.key, k.type) }}>
          <span className={css.keyType}>{k.type}</span>
          <span className={css.keyName} title={k.key}>{node.name}</span>
          {ttl !== '' && <span className={css.ttlBadge} title={`剩余 ${k.ttl} 秒`}>{ttl}</span>}
        </button>
        <div className={css.keyActions}>
          <button type="button" className={css.miniButton} title="复制 key 名" aria-label={`复制 ${k.key}`}
            onClick={() =>{  onCopy(k.key) }}><IconCopyOutlineMedium size={12} /></button>
          <button type="button" className={css.miniButton} title="重命名" aria-label={`重命名 ${k.key}`}
            onClick={() =>{  onRename(k.key) }}><IconEditOutlineMedium size={13} /></button>
          <button type="button" className={css.miniDanger} title="删除" aria-label={`删除 ${k.key}`}
            onClick={() =>{  onDelete(k.key) }}><IconCloseFillMedium size={13} /></button>
        </div>
        <ContextMenu
          menu={menu}
          items={items}
          className={css.menuRoot}
          onSelect={(id) => {
            if (id === 'open') onOpen(k.key, k.type)
            else if (id === 'copy') onCopy(k.key)
            else if (id === 'copy-value') onCopyValue(k.key)
            else if (id === 'add') onOpenAndAdd(k.key, k.type)
            else if (id === 'rename') onRename(k.key)
            else if (id === 'delete') onDelete(k.key)
          }}
        />
      </div>
    )
  }
  const open = expanded.has(node.path)
  // 文件夹勾选态 = 其下全部叶子都已勾选(部分勾选不显示半选,保持布尔简单)。
  const folderChecked = leafKeys(node).every(k => selected.has(k))
  const folderItems: readonly MenuEntry[] = [
    { id: 'toggle', label: open ? '收起' : '展开' },
    { id: 'copy-prefix', label: '复制 key 前缀' },
  ]
  return (
    <>
      <div className={css.keyRow} style={indent} onContextMenu={menu.onContextMenu}>
        <input type="checkbox" className={css.keyCheck} checked={folderChecked} title="全选该文件夹"
          aria-label={`选择文件夹 ${node.path}`}
          onChange={(e) =>{  onToggleFolderSelect(node, e.target.checked) }} />
        <button type="button" className={css.keyMain} onClick={() =>{  onToggle(node.path) }}
          aria-expanded={open} aria-label={`文件夹 ${node.path}`}>
          <span className={css.folderChevron} aria-hidden="true">
            {open ? <IconChevronDownOutlineMedium size={12} /> : <IconChevronRightOutlineMedium size={12} />}
          </span>
          <span className={css.folderName} title={node.path}>{node.name}</span>
          <span className={css.folderCount}>{countLeaves(node)}</span>
        </button>
        <ContextMenu
          menu={menu}
          items={folderItems}
          className={css.menuRoot}
          onSelect={(id) => {
            if (id === 'toggle') onToggle(node.path)
            else if (id === 'copy-prefix') onCopy(node.path)
          }}
        />
      </div>
      {open && node.children.map(child => (
        // key 与同名文件夹可共存(key `a` 与 key `a:b` 会同时出现在根层),
        // 两者的 path 都是 `a`;React key 必须带节点种类前缀,否则重复 key
        // 会让协调器复用错行。
        <KeyTreeRow key={`${child.keyInfo === null ? 'f' : 'k'}:${child.path}`} node={child} depth={depth + 1} expanded={expanded}
          selected={selected}
          onToggle={onToggle} onOpen={onOpen} onOpenAndAdd={onOpenAndAdd} onCopy={onCopy} onCopyValue={onCopyValue}
          onRename={onRename} onDelete={onDelete}
          onToggleSelect={onToggleSelect} onToggleFolderSelect={onToggleFolderSelect} />
      ))}
    </>
  )
}

/** CLI 结果显示文本:对象 JSON 化(含 null),undefined 空串,其余原样。 */
function toCliText(v: unknown): string {
  if (typeof v === 'object') return JSON.stringify(v, null, 2)
  if (v === undefined) return ''
  const primitive = v as string | number | boolean | bigint | symbol
  return String(primitive)
}

/** DB 树一行的动作集(点击展开 / 右键菜单)。 */
interface DbRowActions {
  onToggle: () => void
  onNewKey: () => void
  onRefresh: () => void
  onFlush: () => void
}

/**
 * DB 树单行:点击展开/收起(懒加载键),右键菜单 = 新建 Key / 刷新 / 清空 DB
 * (与 MySQL 库行右键同形态;旧版 Redis db 行没有任何右键入口)。
 * @param props - db 编号、展开态、键总数与动作回调。
 * @returns 该 db 行(含右键菜单锚点)。
 */
function DbTreeRow({ db, open, size, actions }: {
  db: number
  open: boolean
  size: number | undefined
  actions: DbRowActions
}) {
  const menu = useContextMenu()
  const items: readonly MenuEntry[] = [
    { id: 'new-key', label: '新建 Key' },
    { id: 'refresh', label: '刷新' },
    { id: 'sep', type: 'separator' },
    { id: 'flush', label: '清空 DB', danger: true },
  ]
  return (
    <div className={css.dbRow} onContextMenu={menu.onContextMenu}>
      <button type="button" className={css.keyMain} onClick={actions.onToggle}
        aria-expanded={open} aria-label={`数据库 db${db}`}>
        <span className={css.folderChevron} aria-hidden="true">
          {open ? <IconChevronDownOutlineMedium size={12} /> : <IconChevronRightOutlineMedium size={12} />}
        </span>
        <span className={css.dbName}>db{db}</span>
        {size !== undefined && <span className={css.folderCount}>{size.toLocaleString()}</span>}
      </button>
      <ContextMenu
        menu={menu}
        items={items}
        className={css.menuRoot}
        onSelect={(id) => {
          if (id === 'new-key') actions.onNewKey()
          else if (id === 'refresh') actions.onRefresh()
          else if (id === 'flush') actions.onFlush()
        }}
      />
    </div>
  )
}

/**
 * Render the native Redis workbench overlay.
 * @param props - the target asset + close callback.
 * @returns the Redis workbench overlay.
 */
export function RedisWorkbench({ asset, onClose }: { asset: RustAsset; onClose: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  /** 连接尝试序号:失败后点「重试」自增,触发建连 effect 重跑。 */
  const [connectAttempt, setConnectAttempt] = useState(0)
  /** 当前展开的 db;null = 全部收起。 */
  const [expandedDb, setExpandedDb] = useState<number | null>(null)
  /** 客户端当前所在 db(展开切换后恒等于展开的 db)。 */
  const [activeDb, setActiveDb] = useState(0)
  /** 各 db 懒加载缓存(键 + 总数 + 搜索匹配)。 */
  const [dbLists, setDbLists] = useState<ReadonlyMap<number, DbLoadable>>(new Map())
  /** per-db 搜索词(v0.102.0:搜索框移入各 db 区块,词按 db 隔离持久)。 */
  const [searchDrafts, setSearchDrafts] = useState<ReadonlyMap<number, string>>(new Map())
  /** per-db 类型过滤(REDIS_TYPE_FILTERS 之一;'' / 缺省 = 全部,按 db 隔离持久)。 */
  const [typeFilters, setTypeFilters] = useState<ReadonlyMap<number, string>>(new Map())
  /** 批量删除勾选集(db → 已勾选 key 集;该 db 键列表重扫后清空,见 loadKeysForDb)。 */
  const [selectedKeys, setSelectedKeys] = useState<ReadonlyMap<number, ReadonlySet<string>>>(new Map())
  /** 右侧主区页签:键值(现有内容)/ 分析(RedisAnalysisPanel)。 */
  const [mainTab, setMainTab] = useState<'keys' | 'analysis'>('keys')
  const [cliOpen, setCliOpen] = useState(false)
  const [cliInput, setCliInput] = useState('')
  const [cliOutput, setCliOutput] = useState<string>('')
  /** CLI 命令历史(本次会话);historyIdx 为 null 表示正在编辑新行。 */
  const [cliHistory, setCliHistory] = useState<readonly string[]>([])
  const [cliHistoryIdx, setCliHistoryIdx] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [newKeyOpen, setNewKeyOpen] = useState(false)
  const [newKeyDraft, setNewKeyDraft] = useState<NewKeyDraft>({ key: '', type: 'string', value: '', db: 0, field: '', score: '', ttl: '' })
  /** FLUSHDB 二次确认:目标 db(打开弹窗时锁定)与用户输入的确认序号。 */
  const [flushConfirm, setFlushConfirm] = useState<number | null>(null)
  const [flushInput, setFlushInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [openValue, setOpenValue] = useState<{ key: string; type: string; addFocus?: boolean } | null>(null)
  /** 键树文件夹展开态:db → 已展开路径集(默认全收起,点击文件夹行才展开)。 */
  const [expandedKeys, setExpandedKeys] = useState<ReadonlyMap<number, ReadonlySet<string>>>(new Map())
  const connRef = useRef<string | null>(null)

  const notify = useCallback((msg: string) => {
    setToast(msg)
    /* v8 ignore start -- toast 自动消除是时序副作用,由出现断言覆盖 */
    window.setTimeout(() =>{  setToast(cur => (cur === msg ? null : cur)) }, 2500)
    /* v8 ignore stop */
  }, [])

  /** 复制文本到剪贴板;不可用时(非安全上下文/权限拒绝)回退提示,不静默失败。 */
  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(`已复制${label}`)
    } catch {
      notify(`复制失败,请手动选中${label}`)
    }
  }, [notify])

  /** 合并写入某个 db 的加载记录(不存在的 db 以 EMPTY 为基底)。 */
  const patchDbList = useCallback((db: number, patch: Partial<DbLoadable>) => {
    setDbLists(prev => {
      const next = new Map(prev)
      next.set(db, { ...(prev.get(db) ?? EMPTY_DB_LOADABLE), ...patch })
      return next
    })
  }, [])

  /** 刷新某个 db 的键总数(DBSIZE)。 */
  const refreshSizeForDb = useCallback(async (connId: string, db: number) => {
    try {
      const { size } = await redisDBSize(connId)
      patchDbList(db, { size })
    } catch (e: unknown) {
      notify(`获取键数失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }, [notify, patchDbList])

  /** 取/写某个 db 的搜索词(per-db 隔离)。 */
  const searchFor = useCallback((db: number) => searchDrafts.get(db) ?? '', [searchDrafts])
  const setSearchFor = useCallback((db: number, text: string) => {
    setSearchDrafts(prev => new Map(prev).set(db, text))
  }, [])

  /** 取/写某个 db 的类型过滤(per-db 隔离;'' = 全部)。 */
  const typeFilterFor = useCallback((db: number) => typeFilters.get(db) ?? '', [typeFilters])
  const setTypeFilterFor = useCallback((db: number, type: string) => {
    setTypeFilters(prev => new Map(prev).set(db, type))
  }, [])

  /** 取/写某个 db 的批量删除勾选集(per-db 隔离)。 */
  const selectedFor = useCallback((db: number) => selectedKeys.get(db) ?? EMPTY_SELECTED, [selectedKeys])
  const setSelectedFor = useCallback((db: number, keys: ReadonlySet<string>) => {
    setSelectedKeys(prev => new Map(prev).set(db, keys))
  }, [])

  /** 勾选/取消单个 key。 */
  const toggleKeySelected = useCallback((db: number, key: string, checked: boolean) => {
    const next = new Set(selectedFor(db))
    if (checked) next.add(key)
    else next.delete(key)
    setSelectedFor(db, next)
  }, [selectedFor, setSelectedFor])

  /** 勾选/取消文件夹下全部叶子 key(勾选 = 选中该文件夹下全部 key)。 */
  const toggleFolderSelected = useCallback((db: number, node: KeyTreeNode, checked: boolean) => {
    const next = new Set(selectedFor(db))
    for (const k of leafKeys(node)) {
      if (checked) next.add(k)
      else next.delete(k)
    }
    setSelectedFor(db, next)
  }, [selectedFor, setSelectedFor])

  /**
   * 连续加载某个 db 的键并写入该 db 缓存。类型过滤为「全部」时走
   * redisScanAccumulate 分页(游标归零/单批上限,可「加载更多」续传);选中具体
   * 类型时改走 redisScanAll——服务端按类型过滤的一次性全量(complete 恒 true,
   * 无「加载更多」),代价是一次 RPC 可能扫全库。
   * 加载成功后清空该 db 的勾选集:重扫结果可能已变(搜索词/类型过滤变了,或别的
   * 客户端改删过 key),保留旧勾选会让「删除所选」删掉看不见的 key。
   */
  const loadKeysForDb = useCallback(async (connId: string, db: number, match: string, typeFilter: string) => {
    patchDbList(db, { loading: true, error: null })
    try {
      if (typeFilter !== '') {
        const result = await redisScanAll(connId, match === '' ? undefined : match, typeFilter)
        patchDbList(db, { keys: result.keys, cursor: 0, complete: true, loading: false, error: null, match, typeFilter })
      } else {
        const { keys, cursor, complete } = await redisScanAccumulate(
          (cur, m, count) => redisScan(connId, cur, m, count),
          0, match === '' ? undefined : match, [], SCAN_BATCH_LIMIT,
        )
        patchDbList(db, { keys, cursor, complete, loading: false, error: null, match, typeFilter })
      }
      setSelectedFor(db, EMPTY_SELECTED)
    } catch (e: unknown) {
      patchDbList(db, { loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [patchDbList, setSelectedFor])

  /**
   * 从缓存游标续传某个 db 的剩余键(「加载更多」/ 部分缓存展开时自动续传一批):
   * 保留已加载键,redisScanAccumulate 按其 key 去重,再加载至多一批。
   */
  const loadMoreKeysForDb = useCallback(async (connId: string, db: number) => {
    const cached = dbLists.get(db)
    /* v8 ignore next -- 防御:续传仅在已有缓存记录时触发(按钮随展开渲染) */
    if (cached === undefined || cached.complete || cached.loading) return
    patchDbList(db, { loading: true, error: null })
    try {
      const { keys, cursor, complete } = await redisScanAccumulate(
        (cur, m, count) => redisScan(connId, cur, m, count),
        /* v8 ignore next -- 续传守卫要求 complete=false,而 match=null(从未加载)的记录恒 complete=true,null 臂不可达 */
        cached.cursor, cached.match !== null && cached.match !== '' ? cached.match : undefined, cached.keys, cached.keys.length + SCAN_BATCH_LIMIT,
      )
      patchDbList(db, { keys, cursor, complete, loading: false, error: null })
    } catch (e: unknown) {
      patchDbList(db, { loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }, [dbLists, patchDbList])

  // 挂载建连一次,卸载断连;不自动取键(DB 树全部收起,点击才懒加载)。
  useEffect(() => {
    const config = asset.config
    // 采纳资产配置的初始库(config.db):仅 0-15 的整数生效,其余回落 0;建连
    // 成功后同步 activeDb,避免「连接在 dbN 而 UI 以为在 db0」的漂移。
    const configDb = typeof config.db === 'number' && Number.isInteger(config.db) && config.db >= 0 && config.db <= 15 ? config.db : 0
    const connParams = {
      host: typeof config.host === 'string' ? config.host : '',
      port: typeof config.port === 'number' ? config.port : 6379,
      db: configDb,
      ssl: config.ssl === true,
      ...(typeof config.password === 'string' ? { password: config.password } : {}),
    }
    let cancelled = false
    redisConnect(connParams)
      .then(async (info) => {
        /* v8 ignore next -- 卸载竞态守卫 */
        if (cancelled) return
        if (!info.connId) throw new Error('Redis 连接未返回 connId')
        connRef.current = info.connId
        setActiveDb(configDb)
        setConnected(true)
      })
      .catch((e: unknown) => {
        /* v8 ignore start -- `String(e)` 兜底非 Error;`!cancelled` 卸载守卫由成功路径覆盖 */
        if (!cancelled) setConnectError(e instanceof Error ? e.message : String(e))
        /* v8 ignore stop */
      })
    return () => {
      cancelled = true
      /* v8 ignore start -- fire-and-forget 断连 */
      if (connRef.current !== null) void redisDisconnect(connRef.current).catch(() => {})
      /* v8 ignore stop */
    }
    // 资产切换或手动重试时重跑;配置不变的重连不触发(asset.id 稳定)。
  }, [asset.id, connectAttempt])

  /** 连接失败后重试:清错误、复位连接态并重建连接(旧版错误条只有「返回」)。 */
  const retryConnect = (): void => {
    setConnectError(null)
    setConnected(false)
    setConnectAttempt(n => n + 1)
  }

  /** 展开/收起某个 db;展开时切客户端(如需)并懒加载该 db 的键。 */
  const toggleDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    if (expandedDb === db) {
      // 收起:关闭值编辑器,已加载的键留在缓存里,再展开直接命中。
      setExpandedDb(null)
      setOpenValue(null)
      return
    }
    setExpandedDb(db)
    setOpenValue(null)
    if (activeDb !== db) {
      try {
        await redisSelect(connId, db)
        setActiveDb(db)
      } catch (e: unknown) {
        setExpandedDb(cur => (cur === db ? null : cur))
        notify(`切换 DB 失败:${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    const cached = dbLists.get(db)
    const match = toScanMatch(searchFor(db).trim())
    const typeFilter = typeFilterFor(db)
    // 缓存命中:键 + 搜索匹配 + 类型过滤都一致时不再从头请求。完整缓存直接复用;
    // 部分缓存(上次停在单批上限)自动从游标续传一批,避免大 db 每次展开都重扫。
    if (cached !== undefined && cached.match === match && cached.typeFilter === typeFilter) {
      if (cached.complete) return
      void loadMoreKeysForDb(connId, db)
      return
    }
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db, match, typeFilter)])
  }

  /** 重新加载某个 db 的键与总数(错误重试 / 刷新钮共用),沿用该 db 当前搜索词与类型过滤。 */
  const reloadDb = async (db: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db, toScanMatch(searchFor(db).trim()), typeFilterFor(db))])
  }

  /** 重新加载当前展开 db(键操作 / CLI / 清空后的数据同步)。 */
  const refreshExpanded = async (connId: string) => {
    /* v8 ignore next -- 调用方全部保证展开态:键行/刷新钮仅在展开时可用 */
    if (expandedDb === null) return
    const match = toScanMatch(searchFor(expandedDb).trim())
    await Promise.all([refreshSizeForDb(connId, expandedDb), loadKeysForDb(connId, expandedDb, match, typeFilterFor(expandedDb))])
  }

  /**
   * 把客户端切到目标库并在 UI 上展开它(缓存命中则续传/复用)。
   *
   * 用于所有会改变连接所在库的路径(CLI SELECT、新建 key 到别的库):sidecar 的
   * Redis 客户端是持久单库语义,只发 redisSelect 而不同步 expandedDb 会让
   * 「连接在 dbN、UI 显示 dbM」——此后点 dbM 列表里的 key,读/删/改全部落在
   * dbN 的同名 key 上(库漂移,见 FLUSHDB 二次确认的同款防线)。
   */
  const selectAndExpandDb = useCallback(async (connId: string, db: number) => {
    setExpandedDb(db)
    setOpenValue(null)
    if (activeDb !== db) {
      await redisSelect(connId, db)
      setActiveDb(db)
    }
    const cached = dbLists.get(db)
    const match = toScanMatch(searchFor(db).trim())
    const typeFilter = typeFilterFor(db)
    if (cached !== undefined && cached.match === match && cached.typeFilter === typeFilter) {
      if (!cached.complete) void loadMoreKeysForDb(connId, db)
      return
    }
    await Promise.all([refreshSizeForDb(connId, db), loadKeysForDb(connId, db, match, typeFilter)])
  }, [activeDb, dbLists, loadMoreKeysForDb, loadKeysForDb, refreshSizeForDb, searchFor, typeFilterFor])

  // 搜索词/类型过滤防抖:展开 db 的搜索词或类型过滤与其缓存不一致时,停敲 350ms
  // 自动重扫;toggleDb 的首次加载(entry 未建)不在此处触发,避免双请求;加载进行中
  // (toggleDb 首次加载在途)同样跳过,加载落地后 dbLists 变化会重估本效应。
  const expandedSearch = expandedDb === null ? '' : searchFor(expandedDb)
  const expandedTypeFilter = expandedDb === null ? '' : typeFilterFor(expandedDb)
  useEffect(() => {
    if (expandedDb === null) return
    const connId = connRef.current
    if (connId === null) return
    const entry = dbLists.get(expandedDb)
    const desired = toScanMatch(expandedSearch.trim())
    if (entry === undefined || entry.loading || (entry.match === desired && entry.typeFilter === expandedTypeFilter)) return
    const timer = window.setTimeout(() =>{  void loadKeysForDb(connId, expandedDb, desired, expandedTypeFilter) }, SEARCH_DEBOUNCE_MS)
    return () =>{  window.clearTimeout(timer) }
  }, [expandedDb, expandedSearch, expandedTypeFilter, dbLists, loadKeysForDb])

  /** 键变更操作后同步:展开时刷新其键,收起时只刷新当前 db 总数。 */
  const syncAfterMutation = async (connId: string) => {
    if (expandedDb === null) await refreshSizeForDb(connId, activeDb)
    else await refreshExpanded(connId)
  }

  const deleteKey = async (key: string) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    if (!window.confirm(`确定删除 key「${key}」?`)) return
    try {
      await redisDel(connId, [key])
      notify(`已删除:${key}`)
      setOpenValue(cur => (cur?.key === key ? null : cur))
      await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`删除失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 批量删除当前展开 db 的勾选 key:一次 db_redis_del 提交,成功后清空勾选并刷新。 */
  const deleteSelected = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 「删除所选」钮仅在连接后且展开 db 有勾选时渲染 */
    if (connId === null || expandedDb === null) return
    const keys = [...selectedFor(expandedDb)]
    /* v8 ignore next -- 勾选为 0 时按钮不渲染,守卫生不可达 */
    if (keys.length === 0) return
    if (!window.confirm(`确定删除选中的 ${keys.length} 个 key?`)) return
    try {
      await redisDel(connId, keys)
      notify(`已删除 ${keys.length} 个 key`)
      setSelectedFor(expandedDb, EMPTY_SELECTED)
      setOpenValue(cur => (cur !== null && keys.includes(cur.key) ? null : cur))
      await refreshExpanded(connId)
    } catch (e: unknown) {
      /* v8 ignore next -- 宿主桥恒以 Error reject,String 兜底仅防御 */
      notify(`删除失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doRename = async () => {
    const connId = connRef.current
    const target = renaming
    /* v8 ignore next -- 按钮在重命名态下 disabled,防御守卫 */
    if (connId === null || target === null) return
    const next = renameTo.trim()
    if (next === '' || next === target) { setRenaming(null); return }
    try {
      await redisRename(connId, target, next)
      notify('Key 已重命名')
      setRenaming(null)
      setRenameTo('')
      await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`重命名失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开 FLUSHDB 二次确认弹窗:目标库 = 指定 db / 展开库 / 当前库,确认需输入 db 序号。 */
  const askFlushDb = (targetDb?: number) => {
    setFlushInput('')
    setFlushConfirm(targetDb ?? expandedDb ?? activeDb)
  }

  /**
   * 清空指定 db:先显式 redisSelect 把持久连接切到目标库再 FLUSHDB——sidecar 的
   * FlushDB 清的是「连接当前所在库」,库漂移(如 CLI 绕过拦截)时确认文案与实际
   * 清空的库会不一致;select 后 activeDb 与目标库强绑定。
   * @param target - 确认弹窗打开时锁定的目标 db。
   */
  const flushDb = async (target: number) => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    try {
      if (target !== activeDb) {
        await redisSelect(connId, target)
        setActiveDb(target)
      }
      await redisFlushDB(connId)
      setFlushConfirm(null)
      setOpenValue(null)
      notify(`db${target} 已清空`)
      // 上面 setActiveDb 尚未落地,按 target 显式同步(而非闭包内旧 activeDb)。
      if (expandedDb === null) await refreshSizeForDb(connId, target)
      else await refreshExpanded(connId)
    } catch (e: unknown) {
      notify(`清空 DB 失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 打开新建 key 弹窗:目标 db 默认当前展开库(未展开则连接所在库),可改。 */
  const openNewKey = (targetDb?: number) => {
    const db = targetDb ?? expandedDb ?? activeDb
    setNewKeyDraft({ key: '', type: 'string', value: '', db, field: '', score: '', ttl: '' })
    setNewKeyOpen(true)
  }

  const createKey = async () => {
    const connId = connRef.current
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null) return
    const key = newKeyDraft.key.trim()
    /* v8 ignore next -- 空 key 时创建按钮 disabled,守卫生不可达 */
    if (key === '') return
    const ttl = parseNewKeyTtl(newKeyDraft.ttl)
    if (ttl === 'invalid') {
      notify('TTL 必须是正整数(秒),留空表示持久化')
      return
    }
    const built = buildCreateKeyCommand({ ...newKeyDraft, key })
    if (built === null) {
      notify(newKeyDraft.type === 'hash' || newKeyDraft.type === 'stream' ? 'hash / stream 需要填写字段名' : 'zset 需要合法的数字分值')
      return
    }
    const target = newKeyDraft.db
    try {
      // 目标库与连接所在库不一致时先切库(与 FLUSHDB 同款防库漂移),并同步 UI 状态。
      if (target !== activeDb) {
        await redisSelect(connId, target)
        setActiveDb(target)
      }
      await redisExecute(connId, built.command)
      // 非 string 类型的创建命令不含 TTL 语义,创建成功后补 EXPIRE(string 已拼进 SET)。
      if (built.ttl !== null && newKeyDraft.type !== 'string') {
        await redisExecute(connId, `EXPIRE ${redisQuote(key)} ${built.ttl}`)
      }
      setNewKeyOpen(false)
      notify('Key 已创建')
      // 目标库与展开库不一致时,上面已把连接切到目标库——必须把展开态一起
      // 同步过去(与 CLI SELECT 同策略),否则 UI 停在旧库而连接在新库,
      // 之后点旧库的 key 会误读/误删目标库的同名 key。
      if (expandedDb === target) await refreshExpanded(connId)
      else await selectAndExpandDb(connId, target)
    } catch (e: unknown) {
      notify(`创建失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const runCli = async () => {
    const connId = connRef.current
    const command = cliInput.trim()
    /* v8 ignore next -- 仅连接建立后触发 */
    if (connId === null || command === '') return
    // SELECT 不透传给 sidecar:持久连接的 Select 会真实切换所在库,而 UI 的
    // activeDb/expandedDb 不跟随 → 后续 FLUSHDB/删除/键列表全作用在「看不见的库」。
    // 改为走 redisSelect RPC 并同步 UI 状态与键列表。
    const selectTarget = parseCliSelect(command)
    if (selectTarget === 'invalid') {
      setCliOutput('无效的 db 序号:SELECT 只接受 0-15 的整数,如 SELECT 3')
      return
    }
    if (selectTarget !== null) {
      if (selectTarget === activeDb && expandedDb === selectTarget) {
        setCliOutput(`已在 db${selectTarget}`)
        return
      }
      try {
        // 与新建 key 同一条库同步路径:切连接 + 展开态跟随 + 键列表加载,
        // 保证「UI 展示的库」恒等于「连接所在库」。
        await selectAndExpandDb(connId, selectTarget)
        setCliOutput(`已切换到 db${selectTarget}`)
      } catch (e: unknown) {
        /* v8 ignore next -- 宿主桥恒以 Error reject,String 兜底仅防御 */
        setCliOutput(`切换 DB 失败:${e instanceof Error ? e.message : String(e)}`)
      }
      // SELECT 也入历史,便于复查切库轨迹。
      pushCliHistory(command)
      return
    }
    try {
      const res = await redisExecute(connId, command)
      setCliOutput(res.error ?? toCliText(res.result))
      // 只读命令(GET/KEYS/HGETALL/TTL…)不改变键空间:跳过全库重扫。旧版
      // 无脑 refreshExpanded,大库上每条只读命令都要等一次全量 SCAN。
      if (isMutatingRedisCommand(command)) await syncAfterMutation(connId)
      pushCliHistory(command)
    } catch (e: unknown) {
      setCliOutput(e instanceof Error ? e.message : String(e))
    }
  }

  /** 把一条命令压入 CLI 历史(去重连续重复,超上限丢最旧)。 */
  const pushCliHistory = (command: string) => {
    setCliHistory(prev => {
      const last = prev[prev.length - 1]
      const base = last === command ? prev.slice(0, -1) : prev
      const next = [...base, command]
      return next.length > CLI_HISTORY_LIMIT ? next.slice(next.length - CLI_HISTORY_LIMIT) : next
    })
    setCliHistoryIdx(null)
  }

  /**
   * CLI 输入框方向键:↑ 翻上一条历史,↓ 翻下一条(到最新一条之后回到空行)。
   * @param key - 按下的键名。
   * @returns 命中历史翻阅时 true(调用方阻止默认行为)。
   */
  const handleCliKeyDown = (key: string): boolean => {
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return false
    if (cliHistory.length === 0) return false
    if (key === 'ArrowUp') {
      const nextIdx = cliHistoryIdx === null ? cliHistory.length - 1 : Math.max(0, cliHistoryIdx - 1)
      setCliHistoryIdx(nextIdx)
      setCliInput(cliHistory[nextIdx] ?? '')
      return true
    }
    if (cliHistoryIdx === null) return false
    const nextIdx = cliHistoryIdx + 1
    if (nextIdx >= cliHistory.length) {
      setCliHistoryIdx(null)
      setCliInput('')
      return true
    }
    setCliHistoryIdx(nextIdx)
    setCliInput(cliHistory[nextIdx] ?? '')
    return true
  }

  const openKey = useCallback((key: string, type: string) =>{  setOpenValue({ key, type }) }, [])

  /**
   * 右键「添加成员」:打开 key 并带上聚焦标志——值编辑器(按 key 重挂载)挂载
   * 后把焦点落到「新增成员」输入行,省去成员多的集合滚到最底部的步骤。
   */
  const openKeyAndAdd = useCallback((key: string, type: string) => {
    setOpenValue({ key, type, addFocus: true })
  }, [])

  /** 右键「复制 value」:按当前类型取一次值再进剪贴板(string 取原文,其余 JSON 化)。 */
  const copyKeyValue = useCallback(async (key: string) => {
    const connId = connRef.current
    /* v8 ignore next -- 右键菜单仅在连接后可用 */
    if (connId === null) return
    try {
      const result = await redisGetValue(connId, key)
      const text = result.type === 'string' && typeof result.value === 'string'
        ? result.value
        : JSON.stringify(result.value, null, 2)
      await copyText(text, 'value')
    } catch (e: unknown) {
      notify(`复制 value 失败:${e instanceof Error ? e.message : String(e)}`)
    }
  }, [copyText, notify])

  /** 展开/收起某个 db 里的键文件夹(展开集按 db 隔离,会话内持久)。 */
  const toggleKeyFolder = useCallback((db: number, path: string) => {
    setExpandedKeys(prev => {
      const next = new Map(prev)
      const cur = new Set(next.get(db) ?? [])
      if (cur.has(path)) cur.delete(path)
      else cur.add(path)
      next.set(db, cur)
      return next
    })
  }, [])

  /** 当前展开 db 的加载记录与键树(收起时为空)。 */
  const expandedEntry = expandedDb !== null ? dbLists.get(expandedDb) : undefined
  const keyTree = useMemo(() => buildKeyTree(expandedEntry?.keys ?? []), [expandedEntry?.keys])
  const expandedFolders = useMemo(() => {
    // 搜索态强制全展开,让过滤结果直接可见;否则默认全收起,只显示已点开的文件夹。
    if (expandedSearch.trim() !== '') return allFolderPaths(keyTree)
    if (expandedDb === null) return EMPTY_FOLDER_PATHS
    return expandedKeys.get(expandedDb) ?? EMPTY_FOLDER_PATHS
  }, [keyTree, expandedKeys, expandedDb, expandedSearch])

  const id = connRef.current
  const shownDb = expandedDb ?? activeDb
  const shownEntry = dbLists.get(shownDb)

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`Redis ${asset.name}`}>
        <header className={css.header}>
          <div className={css.headLeft}>
            <span className={css.title}>{asset.name}</span>
            <span className={css.statusDot}>{connected ? '已连接' : '未连接'}</span>
            <span className={css.badge} data-testid="redis-head-badge">db{shownDb}</span>
            <span className={css.keyCount} data-testid="redis-head-count">{(shownEntry?.size ?? 0).toLocaleString()} keys</span>
          </div>
          <button type="button" className={css.closeButton} onClick={onClose}>关闭</button>
        </header>

        {connectError !== null && (
          <div className={css.errorBar}>
            <span>{connectError}</span>
            <button type="button" className={css.retryButton} onClick={retryConnect}>重试</button>
            <button type="button" className={css.secondaryButton} onClick={onClose}>返回</button>
          </div>
        )}

        {connectError === null && (
          <div className={css.body}>
            <div className={css.side}>
              <div className={css.toolbar}>
                <button type="button" className={css.iconButton} title="刷新" aria-label="刷新"
                  disabled={!connected || expandedDb === null || expandedEntry?.loading === true}
                  /* v8 ignore next -- 刷新钮在未展开/未连接时 disabled,守卫分支不可达 */
                  onClick={() => { const c = connRef.current; if (c !== null) void refreshExpanded(c) }}>⟳</button>
                <button type="button" className={css.iconButton} title="清空 DB" aria-label="清空 DB"
                  disabled={!connected} onClick={() =>{  askFlushDb() }}><IconTrashOutlineMedium size={15} /></button>
                <button type="button" className={css.iconButton} title="CLI" aria-label="CLI"
                  disabled={!connected} onClick={() =>{  setCliOpen(v => !v) }}><IconCodeOutlineMedium size={15} /></button>
                <span className={css.toolbarSpacer} />
                {expandedDb !== null && selectedFor(expandedDb).size > 0 && (
                  <button type="button" className={css.dangerButton} data-testid="redis-delete-selected"
                    title="批量删除勾选的 key"
                    onClick={() => void deleteSelected()}>删除所选 ({selectedFor(expandedDb).size})</button>
                )}
                <button type="button" className={css.primaryButton} title="新建 Key" aria-label="新建 Key"
                  disabled={!connected} onClick={() =>{  openNewKey() }}><IconPlusOutlineMedium size={14} /> 新建 Key</button>
              </div>

              <div className={css.dbTree} role="tree" aria-label="DB 列表">
                {DB_INDEXES.map(db => {
                  const open = expandedDb === db
                  const entry = dbLists.get(db)
                  return (
                    <div className={`${css.dbNode} ${open ? css.dbNodeOpen : ''}`} key={db} role="treeitem">
                      <DbTreeRow
                        db={db}
                        open={open}
                        size={entry?.size}
                        actions={{
                          onToggle: () =>{  void toggleDb(db) },
                          onNewKey: () =>{  openNewKey(db) },
                          onRefresh: () =>{  void reloadDb(db) },
                          onFlush: () =>{  askFlushDb(db) },
                        }}
                      />
                      {open && (
                        <div className={css.dbChildren}>
                          <div className={css.dbSearchRow}>
                            <input
                              className={css.dbSearch}
                              placeholder={`搜索 db${db} 的 key…`}
                              aria-label="搜索 key"
                              spellCheck={false}
                              value={searchFor(db)}
                              onChange={(e) =>{  setSearchFor(db, e.target.value) }}
                            />
                            {searchFor(db) !== '' && (
                              <button type="button" className={css.dbSearchClear} aria-label="清除搜索" title="清除搜索"
                                onClick={() =>{  setSearchFor(db, '') }}><IconCloseOutlineMedium size={12} /></button>
                            )}
                            {/* 类型过滤(按 db 隔离):非「全部」时该 db 走 scan_all 服务端过滤。 */}
                            <select className={css.dbTypeFilter} aria-label="类型过滤" title="按类型过滤"
                              value={typeFilterFor(db)}
                              onChange={(e) =>{  setTypeFilterFor(db, e.target.value) }}>
                              {REDIS_TYPE_FILTERS.map(t => <option key={t} value={t}>{t === '' ? '全部' : t}</option>)}
                            </select>
                          </div>
                          {entry === undefined && <div className={css.dbStatus}>加载键…</div>}
                          {entry !== undefined && entry.loading && (
                            <div className={css.dbStatus} data-testid="redis-scan-progress">
                              <span>正在加载键… {entry.keys.length.toLocaleString()}{entry.size > 0 ? ` / ${entry.size.toLocaleString()}` : ''}</span>
                            </div>
                          )}
                          {entry !== undefined && !entry.loading && entry.error !== null && (
                            <div className={css.dbStatus}>
                              <span>加载失败:{entry.error}</span>
                              <button type="button" className={css.retryButton}
                                /* v8 ignore next -- 重试钮仅在已连接 + 展开的错误态出现,守卫分支不可达 */
                                onClick={() => { const c = connRef.current; if (c !== null) void reloadDb(db) }}>重试</button>
                            </div>
                          )}
                          {entry !== undefined && !entry.loading && entry.error === null && entry.keys.length === 0 && (
                            <div className={css.dbStatus}>
                              {entry.match !== null && (entry.match !== '' || entry.typeFilter !== '') ? '搜索无匹配 key。' : '暂无 key。'}
                            </div>
                          )}
                          {entry !== undefined && entry.error === null && entry.keys.length > 0 && (
                            <>
                              <div className={css.keyList}>
                                {keyTree.map(node => (
                                  <KeyTreeRow key={`${node.keyInfo === null ? 'f' : 'k'}:${node.path}`} node={node} depth={0} expanded={expandedFolders}
                                    selected={selectedFor(db)}
                                    onToggle={path => void toggleKeyFolder(db, path)} onOpen={openKey}
                                    onOpenAndAdd={openKeyAndAdd}
                                    onCopy={key => void copyText(key, 'key 名')}
                                    onCopyValue={key => void copyKeyValue(key)}
                                    onRename={(key) => { setRenaming(key); setRenameTo(key) }}
                                    onDelete={key => void deleteKey(key)}
                                    onToggleSelect={(key, checked) =>{  toggleKeySelected(db, key, checked) }}
                                    onToggleFolderSelect={(node2, checked) =>{  toggleFolderSelected(db, node2, checked) }} />
                                ))}
                              </div>
                              {/* 部分加载(停在单批上限):展示剩余量 + 按游标续传。 */}
                              {entry.complete === false && (
                                <div className={css.dbStatus}>
                                  <span>已加载 {entry.keys.length.toLocaleString()} / {entry.size.toLocaleString()} keys</span>
                                  <button type="button" className={css.retryButton} data-testid="redis-load-more"
                                    disabled={entry.loading}
                                    onClick={() => { const c = connRef.current; if (c !== null) void loadMoreKeysForDb(c, db) }}>加载更多</button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={css.main}>
              <div className={css.mainTabs} role="tablist">
                <button type="button" role="tab" aria-selected={mainTab === 'keys'}
                  className={mainTab === 'keys' ? css.mainTabActive : css.mainTab}
                  onClick={() =>{  setMainTab('keys') }}>键值</button>
                <button type="button" role="tab" aria-selected={mainTab === 'analysis'}
                  className={mainTab === 'analysis' ? css.mainTabActive : css.mainTab}
                  onClick={() =>{  setMainTab('analysis') }}>分析</button>
              </div>
              {mainTab === 'analysis' ? (
                <RedisAnalysisPanel connId={id} activeDb={activeDb}
                  onOpenKey={(key, type) => {
                    // BigKey 行点击:切回「键值」页并打开该 key(分析基于连接当前库)。
                    setOpenValue({ key, type })
                    setMainTab('keys')
                  }} />
              ) : (
                <>
                  {renaming !== null && (
                    <div className={css.renameBar}>
                      <input className={css.searchInput} value={renameTo} aria-label="新 key 名"
                        placeholder={renaming} onChange={(e) =>{  setRenameTo(e.target.value) }} />
                      <button type="button" className={css.primaryButton} onClick={() => void doRename()}>确认</button>
                      <button type="button" className={css.secondaryButton} onClick={() =>{  setRenaming(null) }}>取消</button>
                    </div>
                  )}
                  {cliOpen && (
                    <div className={css.cliBar}>
                      <input className={css.searchInput} placeholder="redis 命令,如 GET foo(↑↓ 翻历史)" value={cliInput} aria-label="命令输入"
                        onChange={(e) =>{  setCliInput(e.target.value); setCliHistoryIdx(null) }}
                        onKeyDown={(e) => {
                          if (handleCliKeyDown(e.key)) { e.preventDefault(); return }
                          if (e.key === 'Enter') void runCli()
                        }} />
                      <button type="button" className={css.primaryButton} onClick={() => void runCli()}>执行</button>
                    </div>
                  )}
                  {cliOutput !== '' && <pre className={css.cliOutput}>{cliOutput}</pre>}
                  {openValue !== null && id !== null ? (
                    <RedisValueEditor
                      key={openValue.key}
                      connId={id}
                      redisKey={openValue.key}
                      keyType={openValue.type}
                      focusAddOnMount={openValue.addFocus === true}
                      onSaved={() => { const c = connRef.current; if (c !== null) void refreshExpanded(c) }}
                    />
                  ) : (
                    <div className={css.placeholder}>
                      <div className={css.placeholderTitle}>未选择 Key</div>
                      <div className={css.placeholderDesc}>在左侧展开一个 db,点击 key 查看 / 编辑</div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {newKeyOpen && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>新建 Key</div>
              <div className={css.modalFieldRow}>
                <select className={css.modalSelect} aria-label="目标 DB" title="目标 DB"
                  value={newKeyDraft.db} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, db: Number(e.target.value) })) }}>
                  {DB_INDEXES.map(db => <option key={db} value={db}>db{db}</option>)}
                </select>
                <select className={css.modalSelect} aria-label="类型" title="类型"
                  value={newKeyDraft.type} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, type: e.target.value })) }}>
                  {NEW_KEY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <input className={css.searchInput} placeholder="key 名" aria-label="key 名"
                value={newKeyDraft.key} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, key: e.target.value })) }} />
              {(newKeyDraft.type === 'hash' || newKeyDraft.type === 'stream') && (
                <input className={css.searchInput} placeholder={newKeyDraft.type === 'stream' ? '首条目的字段名' : '字段名'} aria-label="字段名"
                  value={newKeyDraft.field} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, field: e.target.value })) }} />
              )}
              {newKeyDraft.type === 'zset' && (
                <input className={css.searchInput} placeholder="分值(数字)" aria-label="分值"
                  spellCheck={false} value={newKeyDraft.score} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, score: e.target.value })) }} />
              )}
              <input className={css.searchInput}
                placeholder={valuePlaceholder(newKeyDraft.type)}
                aria-label={valuePlaceholder(newKeyDraft.type)}
                value={newKeyDraft.value} onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, value: e.target.value })) }} />
              <input className={css.searchInput} placeholder="TTL(秒,空为持久化)" aria-label="TTL(秒)"
                spellCheck={false} value={newKeyDraft.ttl}
                onChange={(e) =>{  setNewKeyDraft(d => ({ ...d, ttl: e.target.value })) }} />
              <div className={css.modalActions}>
                <button type="button" className={css.secondaryButton} onClick={() =>{  setNewKeyOpen(false) }}>取消</button>
                <button type="button" className={css.primaryButton}
                  disabled={newKeyDraft.key.trim() === '' || ((newKeyDraft.type === 'hash' || newKeyDraft.type === 'stream') && newKeyDraft.field.trim() === '')}
                  onClick={() => void createKey()}>创建</button>
              </div>
            </div>
          </div>
        )}

        {flushConfirm !== null && (
          <div className={css.modalBackdrop}>
            <div className={css.modal}>
              <div className={css.modalTitle}>清空 db{flushConfirm}</div>
              <div className={css.placeholderDesc}>将删除 db{flushConfirm} 的全部 key,操作不可恢复。请输入 db 序号 {flushConfirm} 确认:</div>
              <input className={css.searchInput} placeholder={`输入 ${flushConfirm} 确认`} aria-label="确认 db 序号"
                spellCheck={false} value={flushInput}
                onChange={(e) =>{  setFlushInput(e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && flushInput.trim() === String(flushConfirm)) void flushDb(flushConfirm) }} />
              <div className={css.modalActions}>
                <button type="button" className={css.secondaryButton} onClick={() =>{  setFlushConfirm(null) }}>取消</button>
                <button type="button" className={css.dangerButton} disabled={flushInput.trim() !== String(flushConfirm)}
                  onClick={() => void flushDb(flushConfirm)}>清空</button>
              </div>
            </div>
          </div>
        )}

        {toast !== null && <div className={css.toast}>{toast}</div>}
      </section>
    </div>
  )
}
