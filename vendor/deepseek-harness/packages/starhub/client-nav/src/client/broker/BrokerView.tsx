/**
 * Broker(Kafka / NSQ)状态工作台——React 壳内版。
 *
 * 自 `src/views/BrokerView.vue` 迁移(手册 P1 首个最小样本):结构保留、
 * class 换 dsw token、逻辑零改动。挂载即刷新 + 每 30 秒自动刷新(头部开关可
 * 暂停/恢复,大集群上全量拉取有成本);资产类型由 config.dbType 决定
 * (kafka / nsq),连接参数取自资产配置,数据经共享 Tauri 桥调 Rust
 * `broker_overview`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconDataOutlineMedium, IconLinkOutlineMedium, IconListPenOutlineMedium, IconQueueOutlineMedium,
  IconRefreshOutlineMedium, IconSendOutlineMedium, IconWarningOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RustAsset } from '../store.ts'
import { loadBrokerOverview, type BrokerConnectParams, type BrokerKind, type BrokerOverview } from './service.ts'
import { DashboardCard, type DashboardDetailTable } from './DashboardCard.tsx'
import css from './BrokerView.module.css'

/** Broker 视图 props:只读资产(连接参数 + 类型)。 */
export interface BrokerViewProps {
  /** 打开的 broker 资产(config 携带 host/port/凭据;dbType 决定 kafka/nsq)。 */
  asset: RustAsset
}

/** 默认端口(kafka=9092 / nsq=4150,与 Vue 版一致)。 */
function defaultPort(kind: BrokerKind): number {
  return kind === 'kafka' ? 9092 : 4150
}

/**
 * 渲染 Broker 状态工作台:头部(资产名 + endpoint + 刷新)+ 错误提示 +
 * 仪表盘卡片网格(kafka 分区 / nsq 积压等)。
 * @param props - 资产只读 props。
 * @returns 壳内直渲的 Broker 工作台。
 */
export function BrokerView({ asset }: BrokerViewProps) {
  const kind: BrokerKind = asset.config.dbType === 'nsq' ? 'nsq' : 'kafka'
  const [overview, setOverview] = useState<BrokerOverview>({
    kind, status: 'offline', endpoint: '--', nodeCount: 0, resources: [], observedAt: 0,
  })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sampleKey, setSampleKey] = useState(0)
  // 30s 自动刷新开关(默认开,保持既有行为);大集群上全量拉取有成本,可手动停。
  const [autoRefresh, setAutoRefresh] = useState(true)

  const refresh = useCallback(async () => {
    const host = typeof asset.config.host === 'string' ? asset.config.host : ''
    if (host === '') {
      // 未配置地址时也要收敛 loading,否则五张卡片永久停在加载态且不可点。
      setError('未配置 Broker 地址(host),请在连接管理中补充后再试')
      setLoading(false)
      setRefreshing(false)
      return
    }
    setRefreshing(true)
    try {
      // exactOptionalPropertyTypes:可选字段缺省时整体不传(与 Vue 版 undefined 语义一致)。
      const params: BrokerConnectParams = {
        host,
        port: (typeof asset.config.port === 'number' ? asset.config.port : 0) || defaultPort(kind),
      }
      if (typeof asset.config.username === 'string') params.username = asset.config.username
      if (typeof asset.config.password === 'string') params.password = asset.config.password
      if (typeof asset.config.ssl === 'boolean') params.ssl = asset.config.ssl
      const result = await loadBrokerOverview(kind, params)
      setOverview(result)
      setError(null)
      setSampleKey(key => key + 1)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [asset.config, kind])

  // 挂载(或连接参数变化)即刷新一次;定时器独立成 effect——开关只决定定时器
  // 是否存在,暂停时不应顺带触发一次刷新。
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 自动刷新开时每 30s 一次;卸载 / 暂停时清定时器。手动刷新按钮不受开关影响。
  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => { void refresh() }, 30000)
    return () =>{  window.clearInterval(timer) }
  }, [refresh, autoRefresh])

  const totalPartitions = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.partitions || 0), 0),
    [overview.resources],
  )
  const totalDepth = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.depth || 0), 0),
    [overview.resources],
  )
  const totalMessages = useMemo(
    () => overview.resources.reduce((total, resource) => total + (resource.messages || 0), 0),
    [overview.resources],
  )

  const resourceTable = useMemo<DashboardDetailTable>(() => ({
    columns: kind === 'kafka'
      ? [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'partitions', label: '分区', align: 'right' },
        { key: 'leader', label: 'Leader' },
      ]
      : [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'channels', label: 'Channel', align: 'right' },
        { key: 'depth', label: '积压', align: 'right' },
        { key: 'messages', label: '累计消息', align: 'right' },
      ],
    rows: overview.resources.map(resource => ({
      name: resource.name,
      partitions: resource.partitions,
      leader: resource.leader,
      channels: resource.channels,
      depth: resource.depth,
      messages: resource.messages,
    })),
    emptyText: `当前 ${kind.toUpperCase()} 没有可见 Topic。`,
  }), [kind, overview.resources])

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.headerLeft}>
          <span className={css.kindBadge}>{kind.toUpperCase()}</span>
          <span className={css.name}>{asset.name}</span>
          <code className={css.endpoint}>{overview.endpoint}</code>
        </div>
        <button
          type="button"
          className={css.refreshButton}
          title="刷新状态"
          aria-label="刷新状态"
          disabled={refreshing}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutlineMedium size={14} className={refreshing ? css.spin : undefined} />
        </button>
        <button
          type="button"
          className={`${css.autoRefreshButton} ${autoRefresh ? css.autoRefreshOn : ''}`}
          title={autoRefresh ? '自动刷新中(每 30 秒),点击暂停' : '自动刷新已暂停,点击开启(每 30 秒)'}
          aria-label="自动刷新"
          aria-pressed={autoRefresh}
          onClick={() =>{  setAutoRefresh(v => !v) }}
        >
          {autoRefresh ? '自动 30s' : '已暂停'}
        </button>
      </div>

      {error !== null && (
        <div className={css.error}>
          <IconWarningOutlineMedium size={14} />
          {error}
        </div>
      )}

      <div className={css.grid}>
        <DashboardCard
          title="连接状态"
          icon={<IconLinkOutlineMedium size={16} />}
          value={error !== null ? '异常' : overview.status === 'online' ? '在线' : '离线'}
          color={error !== null ? 'red' : 'green'}
          loading={loading}
          chartValue={error !== null ? 0 : 1}
          sampleKey={sampleKey}
          details={[{ label: 'Endpoint', value: overview.endpoint }]}
        />
        <DashboardCard
          title={kind === 'kafka' ? 'Broker 节点' : 'NSQD 节点'}
          icon={<IconDataOutlineMedium size={16} />}
          value={overview.nodeCount}
          color="cyan"
          loading={loading}
          chartValue={overview.nodeCount}
          sampleKey={sampleKey}
        />
        <DashboardCard
          title="Topic 数量"
          icon={<IconListPenOutlineMedium size={16} />}
          value={overview.resources.length}
          color="purple"
          loading={loading}
          chartValue={overview.resources.length}
          sampleKey={sampleKey}
          detailTable={resourceTable}
        />
        <DashboardCard
          title={kind === 'kafka' ? '分区总数' : '当前积压'}
          icon={<IconQueueOutlineMedium size={16} />}
          value={kind === 'kafka' ? totalPartitions : totalDepth}
          color={kind === 'nsq' && totalDepth > 0 ? 'yellow' : 'cyan'}
          loading={loading}
          chartValue={kind === 'kafka' ? totalPartitions : totalDepth}
          sampleKey={sampleKey}
          detailTable={resourceTable}
        />
        {kind === 'nsq' && (
          <DashboardCard
            title="累计消息"
            icon={<IconSendOutlineMedium size={16} />}
            value={totalMessages.toLocaleString()}
            color="green"
            loading={loading}
            chartValue={totalMessages}
            sampleKey={sampleKey}
            detailTable={resourceTable}
          />
        )}
      </div>
    </div>
  )
}
