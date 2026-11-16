/**
 * SQL 查询历史持久化(需求 5 React 化,批次 5)。
 *
 * 与 Vue `src/utils/sqlHistory.ts` 同契约:localStorage 键 `starhub.sqlHistory`,
 * 上限 1000 条,`addHistory` 头部插入。纯函数 + localStorage,便于 100% 覆盖
 * 测试(jsdom 提供 localStorage;写入失败静默忽略)。
 *
 * @module StarHub SQL history (client)
 */

/** 单条查询历史:SQL 文本 + 目标库 + 时间戳。 */
export interface SqlHistoryEntry {
  sql: string
  db: string
  time: number
}

const KEY = 'starhub.sqlHistory'
const MAX = 1000

/**
 * Load the persisted query history.
 * @returns entries in insertion order (newest first); empty array on miss/corrupt.
 */
export function loadHistory(): SqlHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data as SqlHistoryEntry[]
  } catch {
    return []
  }
}

/**
 * Persist the full history list (truncated to MAX entries).
 * @param entries - the history to save; stored newest-first.
 */
export function saveHistory(entries: SqlHistoryEntry[]): void {
  try {
    const trimmed = entries.slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(trimmed))
  } catch { /* quota exceeded, ignore */ }
}

/**
 * Prepend one executed statement to the history and persist.
 * @param sql - the executed SQL text.
 * @param db - the database it ran against (may be empty).
 * @returns the updated history (already persisted).
 */
export function addHistory(sql: string, db: string): SqlHistoryEntry[] {
  const history = loadHistory()
  history.unshift({ sql, db, time: Date.now() })
  saveHistory(history)
  return history
}

/** Remove all persisted query history. */
export function clearHistory(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
