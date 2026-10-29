// @vitest-environment jsdom
/**
 * TabPane:常驻标签面板。切走的标签保留 DOM(不卸载),隐藏期间滚动偏移归零
 * 时重新激活要回填;隐藏面板不进无障碍树(role 查询只命中活动页)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TabPane } from '../src/client/TabPane.tsx'

afterEach(cleanup)

/** 两个互斥标签的最小工作台。 */
function Harness({ active }: { active: boolean }) {
  return (
    <>
      <TabPane active={active} label="查询 1">
        <div data-testid="table-scroll" style={{ overflow: 'auto' }}>
          <span>alice</span>
        </div>
      </TabPane>
      <TabPane active={!active} label="users">
        <span>bob</span>
      </TabPane>
    </>
  )
}

describe('TabPane', () => {
  it('keeps the hidden tab mounted and out of the accessibility tree', () => {
    const view = render(<Harness active />)
    expect(screen.getByText('alice')).toBeTruthy()
    expect(screen.getByText('bob')).toBeTruthy()
    view.rerender(<Harness active={false} />)
    // 切走的查询页仍挂在 DOM(滚动/编辑状态才守得住),只是不可见/不可读。
    expect(screen.getByText('alice')).toBeTruthy()
    expect(screen.queryByRole('tabpanel', { name: '查询 1' })).toBeNull()
    expect(screen.getByRole('tabpanel', { name: 'users' })).toBeTruthy()
  })

  it('restores scroll offsets after the browser zeroes them while hidden', () => {
    const view = render(<Harness active />)
    const scroll = screen.getByTestId('table-scroll')
    scroll.scrollTop = 240
    fireEvent.scroll(scroll)
    view.rerender(<Harness active={false} />)
    // display:none 期间部分浏览器把滚动偏移归零,模拟该行为。
    scroll.scrollTop = 0
    view.rerender(<Harness active />)
    expect(scroll.scrollTop).toBe(240)
  })

  it('labels the active panel for role queries', () => {
    render(<Harness active />)
    expect(screen.getByRole('tabpanel', { name: '查询 1' })).toBeTruthy()
  })
})
