// @vitest-environment jsdom
/**
 * 壳内工作台主面板(去 Tauri 化 M2 第 6 步):标签条一页一签(点签切换、× 关页),
 * 内容区是同源 iframe(承载 /starhub-react/ 独立程序)。无页时渲染兜底空态
 * (不再返回 null 把主区留成白板);关页/切页都经注入回调,不在组件内持有状态。
 * v0.132.0 起标签条只有标签
 * (「返回工具列表」出口移除:关页 = 面板让回会话视图,回工具列表走侧栏
 * 常驻的「工具」行)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  StarHubWorkbenchPanel, type StarHubWorkbenchPanelProps,
} from '../src/client/StarHubWorkbenchPanel.tsx'
import { createWorkbenchPanelStore } from '../src/client/workbench-panel.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderPanel() {
  const store = createWorkbenchPanelStore()
  const activated: string[] = []
  const closed: string[] = []
  const closeWorkbench = vi.fn()
  const rerender = (): void => {
    view.rerender(<StarHubWorkbenchPanel {...props} />)
  }
  // 组件只消费 inject 面的成员(activatePage / closePage / closeWorkbench /
  // useWorkbench);`PropsRuntime<'main'>` 是 SlotMap 派生 share,测试按
  // 「plain stubs for framework hooks」的 sanctioned 路径整体造型,不逐条复刻派生成员。
  const props = {
    activatePage: (key: string) => { activated.push(key); store.activateIfOpen(key); rerender() },
    closePage: (key: string) => { closed.push(key); store.close(key); rerender() },
    closeWorkbench,
    useWorkbench: (selector: (state: never) => unknown) =>
      selector(store.source.getSnapshot() as never),
  } as unknown as StarHubWorkbenchPanelProps
  const view = render(<StarHubWorkbenchPanel {...props} />)
  return { store, activated, closed, closeWorkbench, rerender, container: view.container }
}

describe('StarHubWorkbenchPanel', () => {
  it('renders the empty state without an open page', () => {
    const { container } = renderPanel()
    expect(screen.getByText('没有打开的工作台页面')).toBeTruthy()
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('renders one tab per page and the active iframe', () => {
    const { store, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['验收机', 'MySQL'])
    const frame = screen.getByTitle('MySQL') as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/starhub-react/index.html?asset=a2')
  })

  it('clicking a tab activates that page; the close button closes it', () => {
    const { store, activated, closed, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()

    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(activated).toEqual(['a1'])
    expect((screen.getByTitle('验收机') as HTMLIFrameElement).getAttribute('src'))
      .toBe('/starhub-react/index.html?asset=a1')

    fireEvent.click(screen.getByRole('button', { name: '关闭 MySQL' }))
    expect(closed).toEqual(['a2'])
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['验收机'])
  })

  it('moves the active tab with arrow keys and focuses the next tab', () => {
    const { store, activated, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]!.tabIndex).toBe(-1)
    tabs[1]!.focus()
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' })
    expect(activated).toEqual(['a1'])
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[0])
  })

  it('keeps every page iframe mounted and only toggles visibility when switching tabs', () => {
    const { store, rerender, container } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    store.open({ key: 'a2', title: 'MySQL', url: '/starhub-react/index.html?asset=a2' })
    rerender()
    const frames = Array.from(container.querySelectorAll('iframe'))
    expect(frames).toHaveLength(2)
    const first = screen.getByTitle('验收机') as HTMLIFrameElement
    const second = screen.getByTitle('MySQL') as HTMLIFrameElement
    // 活动页可见,非活动页隐藏但仍是同一个 iframe 文档(不换 src → 不重载)。
    expect(second.getAttribute('aria-hidden')).toBeNull()
    expect(first.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(screen.getAllByRole('tab')[0]!)
    rerender()
    expect(container.querySelectorAll('iframe')).toHaveLength(2)
    const firstAfter = screen.getByTitle('验收机') as HTMLIFrameElement
    expect(firstAfter).toBe(first)
    expect(firstAfter.getAttribute('src')).toBe('/starhub-react/index.html?asset=a1')
    expect(firstAfter.getAttribute('aria-hidden')).toBeNull()
    expect((screen.getByTitle('MySQL') as HTMLIFrameElement).getAttribute('aria-hidden')).toBe('true')
  })

  it('closing the last page shows the empty-state exit', () => {
    const { store, rerender, closeWorkbench } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    rerender()
    fireEvent.click(screen.getByRole('button', { name: '关闭 验收机' }))
    expect(screen.getByText('没有打开的工作台页面')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回会话' }))
    expect(closeWorkbench).toHaveBeenCalledTimes(1)
  })

  it('exposes no in-panel back-to-tools exit (v0.132.0: 关页回会话,侧栏「工具」行为入口)', () => {
    const { store, rerender } = renderPanel()
    store.open({ key: 'a1', title: '验收机', url: '/starhub-react/index.html?asset=a1' })
    rerender()
    expect(screen.queryByRole('button', { name: '返回工具列表' })).toBeNull()
  })
})
