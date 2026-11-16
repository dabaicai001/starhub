// @vitest-environment jsdom
/**
 * ContextMenu 共享胶水:鼠标右键开菜单、键盘入口(Shift+F10 / ContextMenu 键)、
 * 选项分发后自闭、footer 置底项与 label 组标题透传。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextMenu, useContextMenu } from '../src/client/ContextMenu.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

/** 最小宿主:一行 div 接右键与键盘入口,菜单项直出。 */
function Host({ items, footer, onSelect }: {
  items: readonly MenuEntry[]
  footer?: readonly MenuEntry[] | undefined
  onSelect: (id: string) => void
}) {
  const menu = useContextMenu()
  return (
    <div data-testid="row" onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown} tabIndex={0}>
      行
      <ContextMenu
        menu={menu}
        items={items}
        onSelect={onSelect}
        {...(footer === undefined ? {} : { footer })}
        className={undefined}
      />
    </div>
  )
}

const ITEMS: readonly MenuEntry[] = [
  { id: 'open', label: '打开' },
  { type: 'separator', id: 'sep' },
  { id: 'delete', label: '删除', danger: true },
]

describe('ContextMenu', () => {
  it('右键打开菜单并渲染全部项', () => {
    render(<Host items={ITEMS} onSelect={() => {}} />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 100, clientY: 200 })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '打开' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy()
  })

  it('选项点击分发 id 并关闭菜单', () => {
    const onSelect = vi.fn()
    render(<Host items={ITEMS} onSelect={onSelect} />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: '打开' }))
    expect(onSelect).toHaveBeenCalledWith('open')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Shift+F10 键盘打开菜单', () => {
    render(<Host items={ITEMS} onSelect={() => {}} />)
    fireEvent.keyDown(screen.getByTestId('row'), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('ContextMenu 键打开菜单,普通按键不打开', () => {
    render(<Host items={ITEMS} onSelect={() => {}} />)
    const row = screen.getByTestId('row')
    fireEvent.keyDown(row, { key: 'a' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Escape 关闭菜单', () => {
    render(<Host items={ITEMS} onSelect={() => {}} />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('footer 置底项与 label 组标题透传渲染', () => {
    const items: readonly MenuEntry[] = [
      { type: 'label', id: 'g1', text: '复制' },
      { id: 'copy-name', label: '复制名称' },
    ]
    const footer: readonly MenuEntry[] = [{ id: 'delete', label: '删除', danger: true }]
    render(<Host items={items} footer={footer} onSelect={() => {}} />)
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
    expect(screen.getByText('复制')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '复制名称' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy()
  })
})
