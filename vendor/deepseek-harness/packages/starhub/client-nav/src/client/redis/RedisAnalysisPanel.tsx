/**
 * Redis 分析页签(RedisWorkbench 右侧主区「分析」页)。
 *
 * 四块内容:
 * - **服务器信息**:db_redis_info 全量 INFO,parseRedisInfo 按 `# Section`
 *   分组成键值表格;
 * - **慢日志**:db_redis_slowlog_get(100 条),支持「清空慢日志」
 *   (SLOWLOG RESET 后重新加载);
 * - **BigKey 扫描**:db_redis_bigkey_scan(match + string 字节阈值 + 集合
 *   成员数阈值),结果行可点击——切回「键值」页并打开该 key;
 * - **内存分析**:db_redis_memory_analysis 按前缀聚合(key 数 / 总字节 / 占比)。
 *
 * 语义:BigKey 与内存分析作用在**连接当前所在库**(sidecar 的 Redis 客户端是
 * 单库语义),即工作台的 activeDb;INFO 与慢日志是服务器级,与库无关。服务器
 * 信息与慢日志在进入页签(组件挂载)时自动加载;BigKey 与内存分析可能扫全库、
 * 较慢,只在点「开始扫描 / 开始分析」时手动触发。各块独立错误态与「重新加载」。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  redisBigkeyScan, redisInfo, redisMemoryAnalysis, redisSlowlogGet, redisSlowlogReset,
  type RedisBigKeyEntry, type RedisMemoryAnalysisEntry, type RedisSlowlogEntry,
} from './redis-service.ts'
import css from './RedisWorkbench.module.css'

/** INFO 文本的一个 section(标题 + 键值行)。 */
export interface RedisInfoSection {
  title: string
  entries: Array<[string, string]>
}

/**
 * 解析 INFO 文本:`# xxx` 行开新 section,`k:v` 行入当前 section;空行、
 * section 之前的键值行与无冒号行忽略。
 * @param text - db_redis_info 返回的原始文本。
 * @returns section 列表(按出现顺序)。
 */
export function parseRedisInfo(text: string): RedisInfoSection[] {
  const sections: RedisInfoSection[] = []
  let current: RedisInfoSection | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      current = { title: line.slice(1).trim(), entries: [] }
      sections.push(current)
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0 || current === null) continue
    current.entries.push([line.slice(0, idx), line.slice(idx + 1)])
  }
  return sections
}

/** 单块数据的加载状态(data 恒有值:idle/loading/error 时为初值)。 */
interface BlockState<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T
  error: string
}

/** 构造 idle 态(data 为块初值:文本 '' / 列表 [])。 */
function idleBlock<T>(data: T): BlockState<T> {
  return { status: 'idle', data, error: '' }
}

/** reject 值 → 展示文本(非 Error 走 String 兜底,与工作台 toast 同风格)。 */
function errorText(e: unknown): string {
  /* v8 ignore next -- tauriInvoke 恒以 Error reject(宿主桥把 error 包成字符串信封),String 兜底仅防御 */
  return e instanceof Error ? e.message : String(e)
}

/** 块的错误态行:错误文本 + 重新加载钮。 */
function BlockError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className={css.analysisStatus}>
      <span>加载失败:{error}</span>
      <button type="button" className={css.retryButton} onClick={onRetry}>重新加载</button>
    </div>
  )
}

/** 分析页签入参。 */
export interface RedisAnalysisPanelProps {
  /** 连接 id(未连接时为 null,块停留在 idle)。 */
  connId: string | null
  /** 连接当前所在库:BigKey / 内存分析的扫描范围(单库语义)。 */
  activeDb: number
  /** BigKey 行点击回调:工作台切回「键值」页并打开该 key。 */
  onOpenKey: (key: string, type: string) => void
}

/**
 * Render the Redis analysis tab (server info / slowlog / bigkey / memory).
 * @param props - connection id, current db, and the open-key callback.
 * @returns the analysis panel.
 */
export function RedisAnalysisPanel({ connId, activeDb, onOpenKey }: RedisAnalysisPanelProps) {
  const [info, setInfo] = useState<BlockState<string>>(idleBlock(''))
  const [slowlog, setSlowlog] = useState<BlockState<RedisSlowlogEntry[]>>(idleBlock([]))
  const [bigkey, setBigkey] = useState<BlockState<RedisBigKeyEntry[]>>(idleBlock([]))
  const [memory, setMemory] = useState<BlockState<RedisMemoryAnalysisEntry[]>>(idleBlock([]))
  const [bigkeyForm, setBigkeyForm] = useState({ match: '', stringThreshold: '10240', memberThreshold: '1000' })

  const loadInfo = useCallback(async () => {
    /* v8 ignore next -- 页签仅在连接建立后可进入,connId null 守卫不可达 */
    if (connId === null) return
    setInfo({ status: 'loading', data: '', error: '' })
    try {
      setInfo({ status: 'ready', data: await redisInfo(connId), error: '' })
    } catch (e: unknown) {
      setInfo({ status: 'error', data: '', error: errorText(e) })
    }
  }, [connId])

  const loadSlowlog = useCallback(async () => {
    /* v8 ignore next -- 页签仅在连接建立后可进入,connId null 守卫不可达 */
    if (connId === null) return
    setSlowlog({ status: 'loading', data: [], error: '' })
    try {
      setSlowlog({ status: 'ready', data: await redisSlowlogGet(connId, 100), error: '' })
    } catch (e: unknown) {
      setSlowlog({ status: 'error', data: [], error: errorText(e) })
    }
  }, [connId])

  // 进入页签(挂载)即加载服务器级数据;BigKey / 内存分析手动触发。
  useEffect(() => {
    void loadInfo()
    void loadSlowlog()
  }, [loadInfo, loadSlowlog])

  /** 清空慢日志:确认后 SLOWLOG RESET 并重新加载。 */
  const resetSlowlog = async () => {
    /* v8 ignore next -- 清空钮仅在慢日志加载完成(已连接)后可用 */
    if (connId === null) return
    if (!window.confirm('确定清空慢查询日志?')) return
    try {
      await redisSlowlogReset(connId)
      await loadSlowlog()
    } catch (e: unknown) {
      setSlowlog({ status: 'error', data: [], error: errorText(e) })
    }
  }

  /** 手动触发 BigKey 扫描(可能扫全库,慢);阈值为 0/非法时交 sidecar 缺省。 */
  const runBigkeyScan = async () => {
    /* v8 ignore next -- 页签仅在连接建立后可进入,connId null 守卫不可达 */
    if (connId === null) return
    setBigkey({ status: 'loading', data: [], error: '' })
    try {
      const match = bigkeyForm.match.trim()
      const data = await redisBigkeyScan(connId,
        match === '' ? undefined : match,
        Number(bigkeyForm.stringThreshold) || undefined,
        Number(bigkeyForm.memberThreshold) || undefined)
      setBigkey({ status: 'ready', data, error: '' })
    } catch (e: unknown) {
      setBigkey({ status: 'error', data: [], error: errorText(e) })
    }
  }

  /** 手动触发内存分析(按前缀聚合 MEMORY USAGE 采样;可能扫全库,慢)。 */
  const runMemoryAnalysis = async () => {
    /* v8 ignore next -- 页签仅在连接建立后可进入,connId null 守卫不可达 */
    if (connId === null) return
    setMemory({ status: 'loading', data: [], error: '' })
    try {
      setMemory({ status: 'ready', data: await redisMemoryAnalysis(connId), error: '' })
    } catch (e: unknown) {
      setMemory({ status: 'error', data: [], error: errorText(e) })
    }
  }

  return (
    <div className={css.analysis}>
      <section className={css.analysisBlock} aria-label="服务器信息">
        <div className={css.analysisTitle}>服务器信息</div>
        {info.status === 'error' ? <BlockError error={info.error} onRetry={() => void loadInfo()} />
          : info.status === 'ready' ? parseRedisInfo(info.data).map(section => (
            <div key={section.title} className={css.analysisSection}>
              <div className={css.analysisSectionTitle}>{section.title}</div>
              <table className={css.analysisTable}>
                <tbody>
                  {section.entries.map(([k, v]) => (
                    <tr key={k}><td className={css.analysisKey}>{k}</td><td className={css.analysisValue}>{v}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
            : <div className={css.analysisStatus}>加载中…</div>}
      </section>

      <section className={css.analysisBlock} aria-label="慢日志">
        <div className={css.analysisTitleRow}>
          <div className={css.analysisTitle}>慢日志</div>
          <button type="button" className={css.retryButton}
            disabled={slowlog.status !== 'ready' || slowlog.data.length === 0}
            onClick={() => void resetSlowlog()}>清空慢日志</button>
        </div>
        {slowlog.status === 'error' && <BlockError error={slowlog.error} onRetry={() => void loadSlowlog()} />}
        {slowlog.status !== 'error' && slowlog.status !== 'ready' && <div className={css.analysisStatus}>加载中…</div>}
        {slowlog.status === 'ready' && (slowlog.data.length === 0 ? (
          <div className={css.analysisStatus}>无慢查询记录。</div>
        ) : (
          <table className={css.analysisTable}>
            <thead><tr><th>时间</th><th>耗时</th><th>命令</th></tr></thead>
            <tbody>
              {slowlog.data.map(entry => (
                <tr key={entry.id}>
                  <td className={css.analysisKey}>{new Date(entry.timestamp * 1000).toLocaleString()}</td>
                  <td className={css.analysisValue}>{(entry.duration / 1000).toFixed(1)} ms</td>
                  <td className={css.analysisValue}>{entry.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>

      <section className={css.analysisBlock} aria-label="BigKey 扫描">
        <div className={css.analysisTitleRow}>
          <div className={css.analysisTitle}>BigKey 扫描(db{activeDb})</div>
          <button type="button" className={css.retryButton} disabled={bigkey.status === 'loading'}
            onClick={() => void runBigkeyScan()}>开始扫描</button>
        </div>
        <div className={css.analysisForm}>
          <input className={css.analysisInput} placeholder="MATCH 模式,如 user:*(空为全部)" aria-label="BigKey MATCH 模式"
            spellCheck={false} value={bigkeyForm.match}
            onChange={(e) =>{  setBigkeyForm(f => ({ ...f, match: e.target.value })) }} />
          <input className={css.analysisInput} placeholder="string 字节阈值(默认 10240)" aria-label="string 字节阈值"
            spellCheck={false} value={bigkeyForm.stringThreshold}
            onChange={(e) =>{  setBigkeyForm(f => ({ ...f, stringThreshold: e.target.value })) }} />
          <input className={css.analysisInput} placeholder="集合成员数阈值(默认 1000)" aria-label="集合成员数阈值"
            spellCheck={false} value={bigkeyForm.memberThreshold}
            onChange={(e) =>{  setBigkeyForm(f => ({ ...f, memberThreshold: e.target.value })) }} />
        </div>
        {bigkey.status === 'error' && <BlockError error={bigkey.error} onRetry={() => void runBigkeyScan()} />}
        {bigkey.status === 'loading' && <div className={css.analysisStatus}>扫描中…</div>}
        {bigkey.status === 'ready' && (bigkey.data.length === 0 ? (
          <div className={css.analysisStatus}>未发现大 key。</div>
        ) : (
          <table className={css.analysisTable}>
            <thead><tr><th>Key</th><th>类型</th><th>大小 / 成员数</th></tr></thead>
            <tbody>
              {bigkey.data.map(entry => (
                <tr key={entry.key}>
                  <td>
                    {/* 点击跳回「键值」页打开该 key;分析基于连接当前库,该 key 必在 activeDb。 */}
                    <button type="button" className={css.analysisKeyButton}
                      onClick={() =>{  onOpenKey(entry.key, entry.type) }}>{entry.key}</button>
                  </td>
                  <td className={css.analysisValue}>{entry.type}</td>
                  <td className={css.analysisValue}>
                    {entry.type === 'string' ? `${entry.size.toLocaleString()} B` : `${entry.length.toLocaleString()} 成员`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>

      <section className={css.analysisBlock} aria-label="内存分析">
        <div className={css.analysisTitleRow}>
          <div className={css.analysisTitle}>内存分析(db{activeDb})</div>
          <button type="button" className={css.retryButton} disabled={memory.status === 'loading'}
            onClick={() => void runMemoryAnalysis()}>开始分析</button>
        </div>
        {memory.status === 'error' && <BlockError error={memory.error} onRetry={() => void runMemoryAnalysis()} />}
        {memory.status === 'loading' && <div className={css.analysisStatus}>分析中…</div>}
        {memory.status === 'ready' && (memory.data.length === 0 ? (
          <div className={css.analysisStatus}>暂无数据(当前库无 key)。</div>
        ) : (
          <table className={css.analysisTable}>
            <thead><tr><th>前缀</th><th>Key 数</th><th>总字节</th><th>占比</th></tr></thead>
            <tbody>
              {memory.data.map(entry => (
                <tr key={entry.prefix}>
                  <td className={css.analysisKey}>{entry.prefix}</td>
                  <td className={css.analysisValue}>{entry.keys.toLocaleString()}</td>
                  <td className={css.analysisValue}>{entry.memory.toLocaleString()} B</td>
                  <td className={css.analysisValue}>{entry.percentage.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>
    </div>
  )
}
