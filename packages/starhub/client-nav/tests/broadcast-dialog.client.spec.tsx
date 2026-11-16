// @vitest-environment jsdom
/**
 * BroadcastDialog(需求 6 React 化,broadcast 子集):会话多选(全选/全不选/单
 * 项切换)+ 命令输入(Enter 提交 / Escape 取消)+ 提交流程(空命令 / 空选中禁用,
 * 无会话渲染 null)。纯组件全覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BroadcastDialog } from '../src/client/terminal/BroadcastDialog.tsx'

const SESSIONS = [
  { sessionId: 'a', title: 'web-1', host: 'deploy@10.0.0.1:22' },
  { sessionId: 'b', title: 'web-2', host: 'deploy@10.0.0.2:22' },
  { sessionId: 'c', title: 'db', host: 'root@10.0.0.3:22' },
]

afterEach(() => { cleanup() })

describe('BroadcastDialog', () => {
  it('renders null when there are no sessions', () => {
    const { container } = render(
      <BroadcastDialog sessions={[]} onSubmit={vi.fn()} onClose={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('defaults to all sessions selected and shows the count', () => {
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/已选 3 \/ 3/)).toBeTruthy()
    expect(screen.getByText('已全选')).toBeTruthy()
  })

  it('submits the command and selected ids via Enter and the button', () => {
    const onSubmit = vi.fn()
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = screen.getByLabelText('广播命令')
    fireEvent.change(input, { target: { value: 'ls -la' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ command: 'ls -la', sessionIds: ['a', 'b', 'c'] })
  })

  it('disables submit for an empty command or no selection', () => {
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={vi.fn()} />)
    // 空命令 → disabled。
    expect(screen.getByText('广播 (3)').hasAttribute('disabled')).toBe(true)
    // 输入命令 → 可提交。
    fireEvent.change(screen.getByLabelText('广播命令'), { target: { value: 'uptime' } })
    expect(screen.getByText('广播 (3)').hasAttribute('disabled')).toBe(false)
    // 全不选 → 禁用。
    fireEvent.click(screen.getByText('全不选'))
    expect(screen.getByText('广播 (0)').hasAttribute('disabled')).toBe(true)
  })

  it('toggles individual sessions and supports select-all / deselect-all', () => {
    const onSubmit = vi.fn()
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={onSubmit} onClose={vi.fn()} />)
    // 取消选择第一个会话(delete 分支)。
    fireEvent.click(screen.getByText('web-1'))
    expect(screen.getByText(/已选 2 \/ 3/)).toBeTruthy()
    // 再点一次重新选中(add 分支)。
    fireEvent.click(screen.getByText('web-1'))
    expect(screen.getByText(/已选 3 \/ 3/)).toBeTruthy()
    // 全不选 → 0。
    fireEvent.click(screen.getByText('全不选'))
    expect(screen.getByText(/已选 0 \/ 3/)).toBeTruthy()
    // 全选 → 3。
    fireEvent.click(screen.getByText('全选'))
    expect(screen.getByText(/已选 3 \/ 3/)).toBeTruthy()
    // 提交只含选中。
    fireEvent.change(screen.getByLabelText('广播命令'), { target: { value: 'pwd' } })
    fireEvent.click(screen.getByText('广播 (3)'))
    expect(onSubmit).toHaveBeenCalledWith({ command: 'pwd', sessionIds: ['a', 'b', 'c'] })
  })

  it('deselect-all hides the all-selected hint', () => {
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('已全选')).toBeTruthy()
    fireEvent.click(screen.getByText('全不选'))
    expect(screen.queryByText('已全选')).toBeNull()
  })

  it('closes via the close button, Escape, and backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={onClose} />,
    )
    // 关闭按钮。
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
    // Escape。
    fireEvent.keyDown(screen.getByLabelText('广播命令'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    // Backdrop 点击(mousedown)。
    fireEvent.mouseDown(container.querySelector('[class*="backdrop"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('cancels via the cancel button', () => {
    const onClose = vi.fn()
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not submit when Enter is pressed while disabled', () => {
    const onSubmit = vi.fn()
    render(<BroadcastDialog sessions={SESSIONS} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = screen.getByLabelText('广播命令')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('stops propagation so a click inside the panel does not close', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BroadcastDialog sessions={SESSIONS} onSubmit={vi.fn()} onClose={onClose} />,
    )
    fireEvent.mouseDown(container.querySelector('[class*="panel"]') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })
})
