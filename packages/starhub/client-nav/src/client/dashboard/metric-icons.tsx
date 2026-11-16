/**
 * DB 监控指标卡图标(线性 SVG,stroke=currentColor,与 dsh 图标风格一致)。
 *
 * 替代原先的 emoji 文本图标(emoji 随系统字体渲染,与深色主题和其余
 * dsh 图标不一致)。dsh ui-primitives 图标集没有时钟/芯片/乌龟等语义,
 * 这里补齐监控专用的最小集合;新增图标保持 16x16 viewBox、1.3px 描边、
 * 圆角端点的同一画法。
 *
 * @module StarHub DB dashboard metric icons (client)
 */

/** 可用的指标图标名。 */
export type MetricIconName =
  | 'clock' | 'memory' | 'key' | 'users' | 'target' | 'chart' | 'terminal' | 'bolt'
  | 'database' | 'table' | 'search' | 'turtle' | 'box' | 'gear' | 'download' | 'upload'
  | 'refresh' | 'link'

/** 图标名 → 线性路径(16x16 viewBox,fill:none + stroke:currentColor)。 */
const PATHS: Record<MetricIconName, string> = {
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.8V8l2.4 1.5',
  memory: 'M4.5 4.5h7v7h-7zM6.2 4.5V2.6M9.8 4.5V2.6M6.2 13.4v-1.9M9.8 13.4v-1.9M4.5 6.2H2.6M4.5 9.8H2.6M13.4 6.2h-1.9M13.4 9.8h-1.9',
  key: 'M5.5 10.5a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM7.9 6.2 13.4 6.2M11.2 6.2v2.2',
  users: 'M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM3.4 13.2c.7-2.4 2.4-3.7 4.6-3.7s3.9 1.3 4.6 3.7',
  target: 'M8 13.5A5.5 5.5 0 1 0 8 2.5a5.5 5.5 0 0 0 0 11zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  chart: 'M2.8 2.8v10.4h10.4M5.4 10.2l2.3-2.8 1.9 1.6 3-3.8',
  terminal: 'M2.5 3.5h11v9h-11zM5 6.4l1.9 1.8L5 10M8.6 10.4h2.4',
  bolt: 'M8.8 2.2 4.4 8.8h2.9l-.9 5 4.7-6.8H8l.8-4.8z',
  database: 'M8 6.1c2.8 0 5-.9 5-2.1S10.8 1.9 8 1.9 3 2.8 3 4s2.2 2.1 5 2.1zM3 4v8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V4M3 8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1',
  table: 'M2.6 3h10.8v10H2.6zM2.6 6.2h10.8M2.6 9.6h10.8M6.6 3v10',
  search: 'M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zM10.2 10.2 13.6 13.6',
  turtle: 'M7.4 12.2c2.9 0 4.9-1.3 4.9-3.2s-2-3.2-4.9-3.2-4.9 1.3-4.9 3.2 2 3.2 4.9 3.2zM12.9 9.4a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM4.6 12v1.6M10.2 12v1.6',
  box: 'M8 1.9 13.5 5v6L8 14.1 2.5 11V5L8 1.9zM8 8 13.4 5M8 8 2.6 5M8 8v6',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 2.4v1.8M8 11.8v1.8M2.4 8h1.8M11.8 8h1.8M4 4l1.3 1.3M10.7 10.7 12 12M12 4l-1.3 1.3M5.3 10.7 4 12',
  download: 'M8 2.4v8M4.6 7.2 8 10.6l3.4-3.4M2.8 13.4h10.4',
  upload: 'M8 10.4v-8M4.6 6 8 2.6 11.4 6M2.8 13.4h10.4',
  refresh: 'M13.2 8A5.2 5.2 0 1 1 8 2.8c1.9 0 3.5 1 4.4 2.5M12.9 2.3v3h-3',
  link: 'M6.6 9.4l2.8-2.8M5.3 7.2 3.9 8.6a2.3 2.3 0 0 0 3.3 3.3l1.4-1.4M10.7 8.8l1.4-1.4a2.3 2.3 0 0 0-3.3-3.3L7.4 5.5',
}

/** 指标卡线性图标。 */
export function MetricIcon({ name, size = 16, className }: { name: MetricIconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" className={className}
      aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

export default MetricIcon
