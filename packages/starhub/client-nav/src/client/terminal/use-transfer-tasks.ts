/**
 * 传输任务投影(会话级,2026-09-11 弹框化改造):把 Rust TransferManager 的
 * 任务表经「挂载 seed + transfer-status/progress 事件」投影成 React 状态。
 *
 * 挂在 SshTerminalOverlay 而非 SftpPanel:面板随侧栏页签卸载,而传输在后台
 * 继续;监听与面板生命周期解耦后,关面板不丢进度(徽标由 overlay 消费)。
 *
 * 修复点(相对旧 SftpPanel 内联实现):
 * - 终态任务保留到手动清除,不再 4 秒自动消失(失败原因可读、重试不失窗口);
 * - 进度用任务级聚合字段(taskTransferred/taskTotal),多文件任务不回跳;
 * - progress 事件按 sessionId 过滤(事件为全窗口广播);
 * - 监听器异步注册的清理竞态:卸载时已 resolve 的直接 off,未 resolve 的
 *   resolve 后立即 off,不再泄漏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { tauriListen, type TauriUnlisten } from '../tauri.ts'
import {
  sftpClearTransfers, sftpListTransfers,
  type TransferProgressEvent, type TransferStatusEvent, type TransferTask,
} from './sftp-service.ts'

/** 终态集合(可清除 / 可重试的失败与取消也在这里)。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/** useTransferTasks 的返回值。 */
export interface TransferTasksApi {
  /** 当前会话的全部任务(新→旧)。 */
  readonly tasks: readonly TransferTask[]
  /** 进行中(排队/传输中/已暂停)任务数:徽标用。 */
  readonly activeCount: number
  /** 每任务实时速度(bytes/s,由节流的 progress 事件差分得出;非运行态为 0)。 */
  readonly speeds: Readonly<Record<string, number>>
  /** 每任务当前文件名(运行中最近一次 progress 上报的)。 */
  readonly activeFiles: Readonly<Record<string, string>>
  /** 上传完成 nonce:每次 upload 任务进 done 自增,面板据此刷新目录。 */
  readonly uploadDoneNonce: number
  /** 清除终态任务(给 id 清单条,否则清全部终态);失败时重 seed 对齐真源。 */
  readonly clearFinished: (transferId?: string) => void
}

/**
 * 订阅并投影某 SSH 会话的传输任务表。
 * @param sessionId - 终端的 SSH 会话 id。
 * @returns 任务投影与操作(见 TransferTasksApi)。
 */
export function useTransferTasks(sessionId: string): TransferTasksApi {
  const [tasks, setTasks] = useState<readonly TransferTask[]>([])
  const [speeds, setSpeeds] = useState<Readonly<Record<string, number>>>({})
  const [activeFiles, setActiveFiles] = useState<Readonly<Record<string, string>>>({})
  const [uploadDoneNonce, setUploadDoneNonce] = useState(0)
  /** 速度差分的上一采样点(taskId → [字节, 时间戳])。 */
  const lastSample = useRef(new Map<string, [number, number]>())

  useEffect(() => {
    let disposed = false
    const offs: TauriUnlisten[] = []
    const track = (p: Promise<TauriUnlisten>): void => {
      void p.then((off) => {
        // 卸载晚于注册完成:立即注销,不泄漏持有死闭包的监听器
        if (disposed) void off()
        else offs.push(off)
      })
    }

    // 挂载 seed 一次(终态任务也在内:保留到用户手动清除)
    sftpListTransfers(sessionId)
      .then((seeded) => { if (!disposed) setTasks(seeded.slice().reverse()) })
      .catch(() => { /* 预览/会话未就绪:保持空列表,事件到达后自然填充 */ })

    track(tauriListen<TransferStatusEvent>('sftp://transfer-status', (ev) => {
      if (ev.sessionId !== sessionId) return
      setTasks((prev) => {
        const idx = prev.findIndex(t => t.id === ev.transferId)
        if (idx === -1) {
          if (TERMINAL_STATUSES.has(ev.status)) return prev
          const task: TransferTask = {
            id: ev.transferId, sessionId: ev.sessionId, direction: ev.direction,
            files: [], status: ev.status, totalBytes: 0, transferredBytes: 0,
            error: ev.error ?? null,
          }
          return [task, ...prev]
        }
        return prev.map(t => t.id === ev.transferId
          ? { ...t, status: ev.status, error: ev.error ?? null }
          : t)
      })
      if (ev.status === 'done' && ev.direction === 'upload' && !disposed) {
        setUploadDoneNonce(n => n + 1)
      }
      if (ev.status !== 'running') {
        lastSample.current.delete(ev.transferId)
        setSpeeds(prev => (prev[ev.transferId] === undefined ? prev : { ...prev, [ev.transferId]: 0 }))
      }
    }))

    track(tauriListen<TransferProgressEvent>('sftp://transfer-progress', (ev) => {
      if (ev.sessionId !== sessionId) return
      const now = Date.now()
      const last = lastSample.current.get(ev.transferId)
      lastSample.current.set(ev.transferId, [ev.taskTransferred, now])
      if (last !== undefined) {
        const dt = (now - last[1]) / 1000
        if (dt > 0) {
          const speed = Math.max(0, Math.round((ev.taskTransferred - last[0]) / dt))
          setSpeeds(prev => ({ ...prev, [ev.transferId]: speed }))
        }
      }
      setActiveFiles(prev => ({ ...prev, [ev.transferId]: ev.fileName }))
      setTasks(prev => prev.map(t => t.id === ev.transferId
        ? {
            ...t,
            transferredBytes: ev.taskTransferred,
            totalBytes: ev.taskTotal > 0 ? ev.taskTotal : t.totalBytes,
            files: t.files.map(f => f.name === ev.fileName ? { ...f, transferred: ev.transferred } : f),
          }
        : t))
    }))

    return () => {
      disposed = true
      for (const off of offs) void off()
      lastSample.current.clear()
    }
  }, [sessionId])

  const clearFinished = useCallback((transferId?: string): void => {
    // 乐观更新本地投影,同时让 Rust 真源同步删除;失败则重 seed 对齐。
    setTasks(prev => prev.filter(t =>
      transferId !== undefined ? t.id !== transferId : !TERMINAL_STATUSES.has(t.status)))
    sftpClearTransfers(sessionId, transferId)
      .catch(() => {
        void sftpListTransfers(sessionId)
          .then(seeded => setTasks(seeded.slice().reverse()))
          .catch(() => { /* 重 seed 也失败:保持本地投影 */ })
      })
  }, [sessionId])

  const activeCount = tasks.filter(t => !TERMINAL_STATUSES.has(t.status)).length
  return { tasks, activeCount, speeds, activeFiles, uploadDoneNonce, clearFinished }
}
