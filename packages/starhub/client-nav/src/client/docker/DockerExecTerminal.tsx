/**
 * Docker 容器交互式终端(exec TTY)。
 *
 * 进入容器并建立带 TTY 的持久交互式 Shell(`docker_exec_session_start`),用
 * xterm 渲染,长轮询 `docker_exec_session_read` 拉输出(base64),`onData`
 * 写回 `docker_exec_session_write`,resize 通知,关闭/卸载时
 * `docker_exec_session_close`。结束后自动清理轮询与监听。复用
 * SshTerminalOverlay 的 xterm 接线方式(FitAddon + ResizeObserver)。
 *
 * 会话三态(此前只有「一片空白」):starting(进入容器中)/ error(启动失败,
 * 可重试)/ ended(shell 退出或被后端空闲回收,可重开)。后两者都会在终端上
 * 覆盖状态条,避免用户对着已销毁的终端不知道该做什么——sidecar 有 10 分钟
 * 空闲回收,静默命中时以前完全没有提示。
 *
 * @module StarHub Docker exec terminal (client)
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ContainerInfo } from './docker-service.ts'
import { useTerminalTheme } from '../terminal/terminal-theme.ts'
import { terminalOptions, useTerminalSettings } from '../terminal/terminal-settings.ts'
import {
  dockerExecSessionClose, dockerExecSessionRead, dockerExecSessionResize,
  dockerExecSessionStart, dockerExecSessionWrite, decodeExecOutput,
} from './docker-service.ts'
import css from './DockerExecTerminal.module.css'

/** exec 会话状态:进入中 / 运行中 / 已结束 / 启动失败。 */
type ExecStatus = 'starting' | 'running' | 'ended' | 'error'

/** 轮询间隔(读自带 1000ms 长轮询超时;0 会在无输出时退化成紧循环)。 */
const POLL_INTERVAL_MS = 150

/**
 * Render one interactive exec session inside a container.
 * @param props - connection id, target container, and a close callback.
 */
export function DockerExecTerminal({ connId, container, onClose }: {
  connId: string
  container: ContainerInfo
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const { theme, termRef } = useTerminalTheme()
  const terminalSettings = useTerminalSettings()
  const [status, setStatus] = useState<ExecStatus>('starting')
  const [error, setError] = useState<string | null>(null)
  /** 会话代次:重试/重开 +1,触发 effect 重建终端与会话。 */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme/settings 在挂载时按当时的显示设置创建终端;主题后续由 useTerminalTheme 动态重刷,字体/字号/光标在下次打开终端时生效。
    let disposed = false
    let sessionId: string | null = null
    let pollTimer: number | undefined

    setStatus('starting')
    setError(null)

    const term = new Terminal({
      ...terminalOptions(terminalSettings),
      theme,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)

    /* v8 ignore start -- ref 始终挂载在弹层内,host.current 恒非空;else 分支防御性保留 */
    if (host.current) term.open(host.current)
    /* v8 ignore stop */
    fit.fit()

    const resize = () => {
      /* v8 ignore start -- else(会话未建/已卸载)为防御守卫;true 由 resize 测试覆盖 */
      if (!disposed && sessionId !== null) {
        fit.fit()
        void dockerExecSessionResize(connId, sessionId, term.cols, term.rows).catch(() => {})
      }
      /* v8 ignore stop */
    }
    const resizeObserver = new ResizeObserver(() =>{  resize() })
    /* v8 ignore start -- ref 恒挂载,observe 分支恒走;else 防御性保留 */
    if (host.current) resizeObserver.observe(host.current)
    /* v8 ignore stop */

    const cleanup = () => {
      // 幂等:会话自然结束时已清理一次,重试/重开时 React 还会再调一次返回的 cleanup,
      // 二次 dispose 会作用在已销毁的终端上。
      if (disposed) return
      disposed = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      resizeObserver.disconnect()
      /* v8 ignore start -- 关闭会话 IPC 失败非致命,fire-and-forget */
      if (sessionId !== null) void dockerExecSessionClose(connId, sessionId).catch(() => {})
      /* v8 ignore stop */
      term.dispose()
    }

    term.onData((data) => {
      /* v8 ignore next -- 卸载后或会话未建时的输入丢弃,防御性守卫 */
      if (disposed || sessionId === null) return
      /* v8 ignore start -- 写入 IPC 失败非致命,fire-and-forget */
      void dockerExecSessionWrite(connId, sessionId, data).catch(() => {})
      /* v8 ignore stop */
    })

    /* 卸载标志经闭包异步翻转;函数读取避免 TS 在 await 后把 disposed 窄化为 false。 */
    const isDisposed = () => disposed

    const poll = async () => {
      /* v8 ignore next -- 卸载后不再轮询,防御性守卫 */
      if (disposed || sessionId === null) return
      let read: Awaited<ReturnType<typeof dockerExecSessionRead>>
      try {
        read = await dockerExecSessionRead(connId, sessionId, 1000)
      } catch (caught: unknown) {
        /* v8 ignore next -- 读取完成前已卸载,丢弃失败,防御性守卫 */
        if (isDisposed()) return
        cleanup()
        setStatus('error')
        setError(`读取终端输出失败: ${caught instanceof Error ? caught.message : String(caught)}`)
        return
      }
      /* v8 ignore next -- 读取完成前已卸载,丢弃结果,防御性守卫 */
      if (isDisposed()) return
      if (read.data !== '') term.write(decodeExecOutput(read.data))
      if (!read.running) {
        // shell 退出或后端 10 分钟空闲回收:关闭会话并显式告知用户(此前只销毁终端、弹层照旧)。
        cleanup()
        setStatus('ended')
        return
      }
      pollTimer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    dockerExecSessionStart(connId, container.id, term.cols, term.rows)
      .then((res) => {
        /* v8 ignore next -- 组件在启动期间卸载,防御性守卫 */
        if (disposed) return
        sessionId = res.sessionId
        setStatus('running')
        void poll()
      })
      .catch((caught: unknown) => {
        /* v8 ignore next -- 启动失败前已卸载,丢弃失败,防御性守卫 */
        if (isDisposed()) return
        setStatus('error')
        setError(caught instanceof Error ? caught.message : String(caught))
      })

    return cleanup
    // 连接与容器在弹层生命周期内恒定,只在挂载/卸载/重试时重建。
  }, [connId, container.id, attempt])

  /** 重试启动 / 重开会话:代次 +1 触发 effect 重建终端与会话。 */
  const restart = (): void => { setAttempt(n => n + 1) }

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`${container.name} 终端`}>
        <header className={css.header}>
          <span className={css.title}>{container.name} · 终端</span>
          <button type="button" className={css.closeButton} onClick={onClose} aria-label="关闭终端">关闭</button>
        </header>
        <div className={css.terminalHost} ref={host} />
        {status === 'starting' && (
          <div className={css.stateBar} role="status">正在进入容器…</div>
        )}
        {status === 'error' && (
          <div className={`${css.stateBar} ${css.stateBarError}`} role="alert">
            <span className={css.stateText}>进入容器失败:{error ?? '未知错误'}</span>
            <button type="button" className={css.stateAction} onClick={restart}>重试</button>
            <button type="button" className={css.stateAction} onClick={onClose}>关闭</button>
          </div>
        )}
        {status === 'ended' && (
          <div className={css.stateBar} role="status">
            <span className={css.stateText}>会话已结束(容器内 shell 已退出,或被空闲回收)。</span>
            <button type="button" className={css.stateAction} onClick={restart}>重新打开</button>
            <button type="button" className={css.stateAction} onClick={onClose}>关闭</button>
          </div>
        )}
      </section>
    </div>
  )
}
