/**
 * 右键菜单共享胶水(StarHub 本地包,规则从简):把 dsh 的 Menu 原语接到
 * 行/条的 onContextMenu 上。右键位置经 portal + anchorPoint 固定成
 * 指针处的零面积矩形,anchor 只占位、不参与交互;项点击由调用方在
 * onSelect 里分发,ContextMenu 负责分发后关闭。样式与 dsh 现有 hover
 * 菜单完全一致(同一 Menu 原语)。
 *
 * 键盘入口:useContextMenu 返回的 onKeyDown 挂在行元素上,Shift+F10 /
 * ContextMenu 键以该行的包围盒为锚点打开菜单(与鼠标右键同语义)。
 * 透传能力:footer / align / side / dense / compact / selectedId /
 * selectedIds 原样透传给 Menu 原语(组标题用 { type:'label' } 条目,
 * 子菜单用 MenuItem.submenu,均为原语既有能力)。
 */
import { useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** 一次右键的指针位置;null = 菜单关闭。 */
export interface ContextMenuPosition {
  x: number
  y: number
}

/** 单个行/条的右键菜单状态与接线。 */
export interface ContextMenuState {
  /** 菜单是否打开。 */
  open: boolean
  /** 行上右键:阻止浏览器原生菜单并记录指针位置。 */
  onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => void
  /** 行上按键:Shift+F10 / ContextMenu 键以行包围盒左下角为锚点打开菜单。 */
  onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault: () => void; currentTarget: { getBoundingClientRect: () => DOMRect } }) => void
  /** 以指定视口坐标打开菜单(「⋮」按钮等备用触发用)。 */
  openAt: (x: number, y: number) => void
  /** 关闭菜单(选择后由 ContextMenu 调用)。 */
  close: () => void
  /** Menu portal 的指针锚点(视口坐标);null = 菜单关闭。 */
  anchorPoint: ContextMenuPosition | null
}

/**
 * Create one row's right-click menu state.
 * @returns the state handle consumed by a ContextMenu render.
 */
export function useContextMenu(): ContextMenuState {
  const [position, setPosition] = useState<ContextMenuPosition | null>(null)
  return {
    open: position !== null,
    onContextMenu: (e) => {
      e.preventDefault()
      setPosition({ x: e.clientX, y: e.clientY })
    },
    onKeyDown: (e) => {
      // Shift+F10 与专用 ContextMenu 键 = 键盘等价右键。
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      setPosition({ x: rect.left, y: rect.bottom })
    },
    openAt: (x, y) => { setPosition({ x, y }) },
    close: () => { setPosition(null) },
    anchorPoint: position,
  }
}

/**
 * Render a right-click menu anchored at the stored pointer position.
 * @param props.menu - the row's context-menu state (useContextMenu).
 * @param props.items - menu rows (dsh MenuEntry,支持 separator / label / danger / disabled / submenu)。
 * @param props.onSelect - item click dispatch; the menu closes itself after it.
 * @param props.footer - 置底固定项(滚动区之下,如「删除」常驻)。
 * @param props.align / props.side - 菜单相对锚点的对齐与开合方向。
 * @param props.dense / props.compact - 紧凑行距 / 紧凑排版。
 * @param props.selectedId / props.selectedIds - 选中标记(勾选项)。
 * @param props.className - wrapper class (callers pass `display: contents` so
 * the empty anchor span never affects the row layout)。
 * @returns the Menu primitive wired for right-click anchoring.
 */
export function ContextMenu({ menu, items, onSelect, footer, align, side, dense, compact, selectedId, selectedIds, className }: {
  menu: ContextMenuState
  items: readonly MenuEntry[]
  onSelect: (id: string) => void
  footer?: readonly MenuEntry[] | undefined
  align?: 'start' | 'end' | undefined
  side?: 'bottom' | 'top' | 'right' | undefined
  dense?: boolean | undefined
  compact?: boolean | undefined
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  className: string | undefined
}) {
  return (
    <Menu
      open={menu.open}
      onClose={menu.close}
      items={items}
      onSelect={(id) => { menu.close(); onSelect(id) }}
      portal
      contextual
      {...(menu.anchorPoint === null ? {} : { anchorPoint: menu.anchorPoint })}
      {...(footer === undefined ? {} : { footer })}
      {...(align === undefined ? {} : { align })}
      {...(side === undefined ? {} : { side })}
      {...(dense === undefined ? {} : { dense })}
      {...(compact === undefined ? {} : { compact })}
      {...(selectedId === undefined ? {} : { selectedId })}
      {...(selectedIds === undefined ? {} : { selectedIds })}
      {...(className === undefined ? {} : { className })}
      anchor={<span aria-hidden="true" />}
    />
  )
}
