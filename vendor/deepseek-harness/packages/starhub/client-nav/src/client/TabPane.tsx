/**
 * 常驻标签面板:标签切走后只隐藏、不卸载。
 *
 * 工作台里的标签(查询草稿、表数据网格、分析页、文件页…)此前用条件渲染切换,
 * 切走即卸载:滚动位置回到顶部,分页/筛选/未保存的单元格编辑与编辑器光标全部
 * 丢失。这里把面板 DOM 保留下来,仅切换可见性:
 * - 未激活:`display:none` + `aria-hidden`(隐藏内容不进无障碍树/焦点顺序);
 * - 激活:`display:contents`,面板自身不产生布局盒,子节点仍按父容器的既有
 *   flex 布局参与布局,接入时无需为每个页面补一层布局 CSS。
 *
 * `display:none` 期间布局盒消失,部分浏览器会把滚动偏移归零;因此滚动容器的
 * 偏移在捕获阶段持续记录、重新激活时回填,保证「切回来还在原处」。
 *
 * @module StarHub keep-alive tab pane (client)
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

/** 一个滚动容器的偏移快照。 */
interface ScrollOffset {
  top: number
  left: number
}

/** 常驻标签面板属性。 */
export interface TabPaneProps {
  /** 是否为当前激活标签。 */
  active: boolean
  /** 标签正文(整个面板)。 */
  children: ReactNode
  /** 面板的无障碍名字(与标签同名);激活时可按 `role=tabpanel` 定位。 */
  label?: string
  /**
   * 激活时是否自建 flex 列填满父容器。默认用 `display:contents` 让子节点直接
   * 参与父容器布局(适配内容区、主区等已有布局);父容器靠 `> *` 给直接子级
   * 撑尺寸时(如 SSH 侧栏)需要显式填空,否则盒模型层数变化会塌掉。
   */
  fill?: boolean
}

/**
 * 渲染一个常驻标签面板:切走只隐藏,不卸载。
 * @param props - 激活态、面板内容、无障碍名字与是否自建填充布局。
 * @returns 面板容器;激活时 `display:contents`(或 fill 的 flex 列),未激活时 `display:none`。
 */
export function TabPane({ active, children, label, fill = false }: TabPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const offsetsRef = useRef(new Map<HTMLElement, ScrollOffset>())
  // 滚动事件不冒泡,但会走捕获阶段:挂在面板根上即可收全部后代滚动容器
  // (网格表体、结果区、CodeMirror scroller、分析列表…)。
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const remember = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      offsetsRef.current.set(target, { top: target.scrollTop, left: target.scrollLeft })
    }
    host.addEventListener('scroll', remember, true)
    return () => { host.removeEventListener('scroll', remember, true) }
  }, [])
  // 重新激活时回填(布局已在 DOM 提交里恢复,浏览器可能已把偏移归零)。
  useLayoutEffect(() => {
    if (!active) return
    const host = hostRef.current
    if (host === null) return
    for (const [element, offset] of offsetsRef.current) {
      if (!host.contains(element)) continue
      if (element.scrollTop !== offset.top) element.scrollTop = offset.top
      if (element.scrollLeft !== offset.left) element.scrollLeft = offset.left
    }
  }, [active])
  const activeStyle = fill
    ? { display: 'flex', flexDirection: 'column' as const, flex: '1 1 0', minWidth: 0, minHeight: 0 }
    : { display: 'contents' as const }
  return (
    <div
      ref={hostRef}
      role="tabpanel"
      {...(label === undefined ? {} : { 'aria-label': label })}
      style={active ? activeStyle : { display: 'none' }}
      aria-hidden={active ? undefined : true}
      data-tab-active={active ? 'true' : 'false'}
    >
      {children}
    </div>
  )
}

export default TabPane
