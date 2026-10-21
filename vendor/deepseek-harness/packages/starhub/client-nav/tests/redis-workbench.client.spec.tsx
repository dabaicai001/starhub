// @vitest-environment jsdom
/**
 * Redis 工作台(RedisWorkbench.tsx):连接/断连生命周期、DB 树(默认全收起,
 * 点击才懒加载该 db 的键;展开/收起/切换/缓存命中)、键树(文件夹分组/搜索/
 * 刷新/空态/错误重试)、键操作(打开/重命名/删除/清空/新建)、CLI,以及打开
 * RedisValueEditor 的值编辑分支。
 * 增强:资产配置初始库、per-db 类型过滤(scan_all)、批量删除勾选、「分析」
 * 页签(INFO/慢日志/BigKey/内存分析)、新建 key 的 TTL。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { buildCreateKeyCommand, isMutatingRedisCommand, parseCliSelect, parseNewKeyTtl, RedisWorkbench, valuePlaceholder } from '../src/client/redis/RedisWorkbench.tsx'
import { parseRedisInfo } from '../src/client/redis/RedisAnalysisPanel.tsx'
import type { RustAsset } from '../src/client/store.ts'
import { restoreHostBridge, stubHostBridge } from './host-bridge.ts'

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown

/** 安装宿主桥 invoke 替身;返回还原回调。 */
function stubInvoke(handler: InvokeHandler): () => void {
  stubHostBridge(handler)
  return () => { restoreHostBridge() }
}

const asset: RustAsset = {
  id: 'r1', type: 'db', name: 'redis-1', group_id: null,
  config: { host: 'h', port: 6379, password: 'secret', ssl: false },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

const keyInfo = (key: string, type = 'string') => ({ key, type, ttl: -1 })

/** 测试拒绝:统一为 Error(组件展示文本与直接 reject 原值一致)。 */
function rejectAsError(e: Error | string): Promise<never> {
  return Promise.reject(typeof e === 'string' ? new Error(e) : e)
}

/** 安装 Tauri 调用分发 stub;`opts` 覆盖各命令返回。 */
function installTauri(opts?: {
  connectError?: Error | string
  sizeError?: Error | string
  scanError?: Error | string
  selectError?: Error | string
  delError?: Error | string
  renameError?: Error | string
  flushError?: Error | string
  executeError?: Error | string
  connectNoId?: boolean
}) {
  const invoke = vi.fn((cmd: string, _args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'db_redis_connect': return opts?.connectError ? rejectAsError(opts.connectError) : Promise.resolve(opts?.connectNoId ? {} : { connId: 'c1', host: 'h', port: 6379 })
      case 'db_redis_db_size': return opts?.sizeError ? rejectAsError(opts.sizeError) : Promise.resolve({ size: 2 })
      case 'db_redis_scan': return opts?.scanError ? rejectAsError(opts.scanError) : Promise.resolve({ keys: [keyInfo('user:1'), keyInfo('sess:2', 'hash')], cursor: 0, total: 2 })
      case 'db_redis_scan_all': return Promise.resolve({ keys: [keyInfo('sess:2', 'hash')], cursor: 0, total: 1 })
      case 'db_redis_get_value': return Promise.resolve({ key: 'user:1', type: 'string', value: 'v', ttl: -1 })
      case 'db_redis_select': return opts?.selectError ? rejectAsError(opts.selectError) : Promise.resolve(null)
      case 'db_redis_del': return opts?.delError ? rejectAsError(opts.delError) : Promise.resolve({ deleted: 1 })
      case 'db_redis_rename': return opts?.renameError ? rejectAsError(opts.renameError) : Promise.resolve(null)
      case 'db_redis_flush_db': return opts?.flushError ? rejectAsError(opts.flushError) : Promise.resolve(null)
      case 'db_redis_execute': return opts?.executeError ? rejectAsError(opts.executeError) : Promise.resolve({ result: 'OK', durationMs: 1 })
      case 'db_redis_disconnect': return Promise.resolve(null)
      case 'db_redis_info': return Promise.resolve('# Server\r\nredis_version:7.0.0\r\n\r\n# Memory\r\nused_memory:1024\r\n')
      case 'db_redis_slowlog_get': return Promise.resolve([{ id: 1, duration: 12345, timestamp: 1700000000, command: 'KEYS *' }])
      case 'db_redis_slowlog_reset': return Promise.resolve(null)
      case 'db_redis_bigkey_scan': return Promise.resolve([])
      case 'db_redis_memory_analysis': return Promise.resolve([])
      default: return Promise.resolve(null)
    }
  })
  return invoke
}

function renderWorkbench(assetOverride: RustAsset = asset, onClose = vi.fn()) {
  return { onClose, ...render(<RedisWorkbench asset={assetOverride} onClose={onClose} />) }
}

/** 等待连接完成(DB 树按钮在连接前点击会被守卫忽略)。 */
async function waitConnected() {
  await waitFor(() =>{  expect(screen.getByText('已连接')).toBeTruthy() })
}

/** 点击展开/收起指定 db。 */
function clickDb(db: number) {
  fireEvent.click(screen.getByRole('button', { name: `数据库 db${db}` }))
}

/** 连接后展开 db0,点开 user 文件夹并等默认 stub 的 user:1 渲染出来。 */
async function expandDb0WithKeys() {
  await waitConnected()
  clickDb(0)
  const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
  fireEvent.click(userFolder)
  await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  restoreHostBridge()
})

describe('RedisWorkbench connect & DB tree', () => {
  it('connects with asset config + password and renders the DB tree collapsed without fetching keys', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: 'h', port: 6379, db: 0, ssl: false, password: 'secret' } })
      // 懒加载:连接后不取任何 db 的键。
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
      // 16 个 db 全收起。
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db15' }).getAttribute('aria-expanded')).toBe('false')
      // 头栏回退到 activeDb(db0),键数为 0;刷新钮在未展开时禁用。
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByTestId('redis-head-count').textContent).toBe('0 keys')
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText('未选择 Key')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('retries a failed connection from the error bar', async () => {
    let attempts = 0
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('conn-boom'))
          : Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      }
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText('conn-boom')).toBeTruthy() })
      // 旧版错误条只有「返回」,连不上只能关窗重开。
      fireEvent.click(screen.getByText('重试'))
      await waitConnected()
      expect(attempts).toBe(2)
      expect(screen.queryByText('conn-boom')).toBeNull()
    } finally {
      restore()
    }
  })

  it('uses default host/port when the config fields are missing or wrong-typed', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench({ ...asset, config: { host: 123, ssl: true } })
      await waitConnected()
      expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: '', port: 6379, db: 0, ssl: true } })
    } finally {
      restore()
    }
  })

  it('expanding a DB lazily loads its keys with folders collapsed by default', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // db0 已是客户端当前库:只 scan + db_size,不 select。
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1' })) })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_select', expect.anything())
      // 键文件夹默认收起:文件夹行在,叶子隐藏。
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByTitle('sess:2')).toBeNull()
      // 点击文件夹才展开该文件夹的叶子;其余文件夹仍收起。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      expect(screen.queryByTitle('sess:2')).toBeNull()
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      // 头栏 + db 行计数徽标随懒加载更新。
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByTestId('redis-head-count').textContent).toBe('2 keys')
      expect(within(screen.getByRole('button', { name: '数据库 db0' })).getByText('2')).toBeTruthy()
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      restore()
    }
  })

  it('expanding another DB switches the client and collapses the previous one', async () => {
    // 每次 SCAN 返回不同键:精确区分「db0 已卸载」与「db3 已加载」。
    let scanCount = 0
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') {
        scanCount += 1
        return Promise.resolve(scanCount === 1
          ? { keys: [keyInfo('user:1'), keyInfo('sess:2', 'hash')], cursor: 0 }
          : { keys: [keyInfo('other:9')], cursor: 0 })
      }
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 先点开 db3 的键文件夹,便于断言其键行。
      clickDb(3)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      await waitFor(() =>{  expect(screen.getByTestId('redis-head-badge').textContent).toBe('db3') })
      const otherFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 other') })
      fireEvent.click(otherFolder)
      await waitFor(() =>{  expect(screen.getByTitle('other:9')).toBeTruthy() })
      // db0 收起:其键行与文件夹卸载(换到 db3 自己的键);db3 展开。
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByLabelText('文件夹 user')).toBeNull()
      await waitFor(() =>{  expect(screen.getByTitle('other:9')).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db3' }).getAttribute('aria-expanded')).toBe('true')
    } finally {
      restore()
    }
  })

  it('collapse keeps the cache (no refetch on re-expand) and closes the value editor', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 先打开一个 key 的值编辑器。
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'user:1' }) })
      // 收起:键行卸载、值编辑器关闭、头栏回退到 activeDb。
      clickDb(0)
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db0')
      expect(screen.getByText('未选择 Key')).toBeTruthy()
      // 缓存命中:再展开不重复请求,键立即回来。
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore) })
    } finally {
      restore()
    }
  })

  it('surfaces a switch rejection with a reverted expand (Error and plain-string)', async () => {
    const onClose = vi.fn()
    const invoke = installTauri({ selectError: new Error('sel-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      clickDb(5)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-boom/)).toBeTruthy() })
      // 切换失败 → 展开回退(两个 db 都收起,db0 的键卸载)。
      expect(screen.getByRole('button', { name: '数据库 db5' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
    } finally {
      restore()
    }
    cleanup()
    const invokePlain = installTauri({ selectError: 'sel-plain' })
    const restorePlain = stubInvoke(invokePlain)
    try {
      renderWorkbench(asset, onClose)
      await waitConnected()
      clickDb(7)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-plain/)).toBeTruthy() })
    } finally {
      restorePlain()
    }
  })

  it('shows the empty state when the expanded DB has no keys', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('creating a key into a collapsed db selects, scans and expands that db (no library drift)', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      // 新建 key 到收起的 db2(全程不展开任何库):旧版只刷 size,连接停在 db2
      // 而 UI 停在 db0——之后点 db0 列表里的 key 会误读/误删 db2 的同名 key
      // (库漂移)。现在与 CLI SELECT 同路径:切库 + 展开态跟随 + 加载键。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('目标 DB')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('目标 DB'), { target: { value: '2' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k2' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 2 })
      // db2 被展开且键已加载:UI 展示的库恒等于连接所在库。
      await waitFor(() =>{  expect(screen.getByRole('button', { name: '数据库 db2' }).getAttribute('aria-expanded')).toBe('true') })
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.queryByText('暂无 key。')).toBeNull()
    } finally {
      restore()
    }
  })

  it('a size-only db record (CLI write while collapsed) still loads keys on expand', async () => {
    // 回归:收折叠态下发写命令 → syncAfterMutation 只刷当前库 size,产生
    // 「有 size、无键」的占位记录;它不得被误判为完整缓存(展开后显示
    // 「暂无 key。」),必须真实 SCAN。
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      fireEvent.change(screen.getByLabelText('命令输入'), { target: { value: 'SET foo bar' } })
      fireEvent.keyDown(screen.getByLabelText('命令输入'), { key: 'Enter' })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_db_size', { connId: 'c1' }) })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_scan', expect.anything())
      // 展开 db0:不得命中占位缓存,必须真实 SCAN 并把键渲染出来。
      clickDb(0)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1' })) })
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.queryByText('暂无 key。')).toBeNull()
    } finally {
      restore()
    }
  })

  it('surfaces a key-list error with a working retry (Error and plain-string)', async () => {
    const invoke = installTauri({ scanError: new Error('scan-fail') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/加载失败:scan-fail/)).toBeTruthy() })
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByText('重试'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
    cleanup()
    // 裸字符串 reject(非 Error)→ 走 `String(e)` 兜底,文本一致。
    const invokeRaw = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.reject('plain scan boom')
      return Promise.resolve(null)
    })
    const restoreRaw = stubInvoke(invokeRaw)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/加载失败:plain scan boom/)).toBeTruthy() })
    } finally {
      restoreRaw()
    }
  })

  it('surfaces a connect rejection with a back action and a missing-connId connect', async () => {
    const onClose = vi.fn()
    const invoke = installTauri({ connectError: new Error('conn-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench(asset, onClose)
      await waitFor(() =>{  expect(screen.getByText('conn-boom')).toBeTruthy() })
      fireEvent.click(screen.getByText('返回'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
    // 连接返回无 connId → 抛错 → errorBar
    const invoke2 = installTauri({ connectNoId: true })
    const restore2 = stubInvoke(invoke2)
    try {
      renderWorkbench()
      await waitFor(() =>{  expect(screen.getByText(/未返回 connId/)).toBeTruthy() })
    } finally {
      restore2()
    }
  })
})

describe('RedisWorkbench lazy DB tree interactions', () => {
  it('groups keys into a folder tree by ":" and expands folders on click', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // 默认全收起:两个文件夹行都在,叶子都被折叠隐藏。
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      expect(screen.getByLabelText('文件夹 sess')).toBeTruthy()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTitle('user:1')).toBeNull()
      expect(screen.queryByTitle('sess:2')).toBeNull()
      // 点击 user 文件夹 → 其叶子出现;sess 分支不受影响、仍收起。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.queryByTitle('sess:2')).toBeNull()
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true')
      expect((screen.getByLabelText('文件夹 sess')).getAttribute('aria-expanded')).toBe('false')
      // 再点 → user 收起,叶子隐藏。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.queryByTitle('user:1')).toBeNull() })
      expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('false')
      // 再点展开 → 叶子恢复(展开集持久)。
      fireEvent.click(screen.getByLabelText('文件夹 user'))
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('searches keys per-db with debounce: glob passthrough, substring wrap, forced folder expansion, clear', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 搜索框在展开的 db 区块内(v0.102.0 起 per-db)。
      const searchBox = screen.getByLabelText('搜索 key')
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      // 含 glob 字符的词原样透传为 MATCH 模式。
      fireEvent.change(searchBox, { target: { value: 'user:*' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1', match: 'user:*' })) })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(scansBefore)
      // 搜索态强制文件夹全展开(结果直接可见)。
      await waitFor(() =>{  expect((screen.getByLabelText('文件夹 user')).getAttribute('aria-expanded')).toBe('true') })
      // 不含 glob 字符的词自动包成子串匹配 *词*。
      fireEvent.change(searchBox, { target: { value: 'user' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1', match: '*user*' })) })
      // 清除按钮清空搜索词 → 触发无 MATCH 的全量重扫。
      const beforeClear = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByLabelText('清除搜索'))
      await waitFor(() =>{  expect((searchBox as HTMLInputElement).value).toBe('') })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(beforeClear) })
      const lastScan = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').at(-1)
      expect((lastScan?.[1] as Record<string, unknown>).match).toBeUndefined()
      // 刷新按钮按当前(空)搜索重扫。
      const before = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.click(screen.getByLabelText('刷新'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(before) })
    } finally {
      restore()
    }
  })

  it('keeps per-db search terms isolated when switching DBs', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: 'user' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ match: '*user*' })) })
      // 切到 db3:其搜索词独立(空),不按 db0 的词过滤。
      clickDb(3)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      await waitFor(() =>{  expect((screen.getByLabelText('搜索 key') as HTMLInputElement).value).toBe('') })
      // 切回 db0:搜索词恢复,缓存匹配串一致 → 不重复请求。
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      clickDb(0)
      await waitFor(() =>{  expect((screen.getByLabelText('搜索 key') as HTMLInputElement).value).toBe('user') })
      await new Promise(res => setTimeout(res, 450))
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore)
    } finally {
      restore()
    }
  })

  it('shows a loading hint and disables refresh while the SCAN is in flight', async () => {
    let releaseScan!: (v: unknown) => void
    const scanGate = new Promise<unknown>(res => { releaseScan = res })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return scanGate
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // SCAN 挂起:加载进度提示可见(含已加载/总数),刷新钮禁用。
      await waitFor(() =>{  expect(screen.getByText(/正在加载键…/)).toBeTruthy() })
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(true)
      releaseScan({ keys: [keyInfo('user:1')], cursor: 0, total: 1 })
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect((screen.getByLabelText('刷新') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      restore()
    }
  })

  it('shows a loading hint while the SELECT (client switch) is in flight', async () => {
    let releaseSelect!: (v: unknown) => void
    const selectGate = new Promise<unknown>(res => { releaseSelect = res })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_select') return selectGate
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(3)
      // SELECT 挂起:目标 db 尚无缓存记录,同样显示加载中。
      await waitFor(() =>{  expect(screen.getByText('加载键…')).toBeTruthy() })
      releaseSelect(null)
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db3')
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench actions', () => {
  it('opens a key into the value editor and shows the placeholder otherwise', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      expect(screen.getByText('未选择 Key')).toBeTruthy()
      fireEvent.click(screen.getByTitle('user:1'))
      // RedisValueEditor 通过 openRef 立即打开该 key → get_value
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'user:1' }) })
      expect(screen.queryByText('未选择 Key')).toBeNull()
    } finally {
      restore()
    }
  })

  it('right-clicks a key row: open / copy key / copy value / rename / delete from the menu', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const writeText = vi.fn(() => Promise.resolve())
    ;(navigator as { clipboard?: unknown }).clipboard = { writeText }
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 右键 key 行 → 菜单(string 不给「添加成员」)。
      fireEvent.contextMenu(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(screen.getByText('复制 key 名')).toBeTruthy() })
      expect(screen.getByText('复制 value')).toBeTruthy()
      expect(screen.queryByText('添加成员')).toBeNull()
      // 复制 value:按当前类型取一次值再进剪贴板。
      fireEvent.click(screen.getByText('复制 value'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'user:1' }) })
      await waitFor(() =>{  expect(screen.getByText('已复制value')).toBeTruthy() })
      expect(writeText).toHaveBeenCalledWith('v')
      // 复制 key 名。
      fireEvent.contextMenu(screen.getByTitle('user:1'))
      fireEvent.click(screen.getByText('复制 key 名'))
      await waitFor(() =>{  expect(screen.getByText('已复制key 名')).toBeTruthy() })
      // 菜单内删除与 hover 按钮同路径(confirm 已置 true)。
      fireEvent.contextMenu(screen.getByTitle('user:1'))
      fireEvent.click(screen.getByText('删除'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['user:1'] }) })
    } finally {
      restore()
      confirmSpy.mockRestore()
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('right-clicks a hash key to add a member: opens the editor focused on the new-member row', async () => {
    // get_value 按 key 分派:sess:2 是 hash(2 个字段),其余回落 string。
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_db_size': return Promise.resolve({ size: 2 })
        case 'db_redis_scan': return Promise.resolve({ keys: [keyInfo('user:1'), keyInfo('sess:2', 'hash')], cursor: 0 })
        case 'db_redis_get_value':
          return Promise.resolve(args?.key === 'sess:2'
            ? { key: 'sess:2', type: 'hash', value: { f1: 'v1' }, ttl: -1, size: 1 }
            : { key: 'user:1', type: 'string', value: 'v', ttl: -1 })
        case 'db_redis_execute': return Promise.resolve({ result: 'OK', durationMs: 1 })
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 展开 sess 文件夹露出 hash key(sess:2)。
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      // hash 类型的右键菜单有「添加成员」;点它 → 编辑器打开且焦点在新字段行。
      fireEvent.contextMenu(screen.getByTitle('sess:2'))
      await waitFor(() =>{  expect(screen.getByText('添加成员')).toBeTruthy() })
      fireEvent.click(screen.getByText('添加成员'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'sess:2' }) })
      await waitFor(() =>{  expect(document.activeElement).toBe(screen.getByLabelText('新字段')) })
      // 顶部常驻新增行:输入字段+值,回车即入表(可连续追加),再保存下发 HSET。
      fireEvent.change(screen.getByLabelText('新字段'), { target: { value: 'f2' } })
      fireEvent.change(screen.getByLabelText('新值'), { target: { value: 'v2' } })
      fireEvent.keyDown(screen.getByLabelText('新值'), { key: 'Enter' })
      // 回车后清空并保持焦点(连续追加)。
      await waitFor(() =>{  expect((screen.getByLabelText<HTMLInputElement>('新字段')).value).toBe('') })
      expect(document.activeElement).toBe(screen.getByLabelText('新字段'))
      fireEvent.click(screen.getByText('保存'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', expect.objectContaining({ command: expect.stringContaining('HSET sess:2 f2 v2') })) })
    } finally {
      restore()
    }
  })

  it('right-clicks a db row for new key / refresh / flush DB', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      // 右键 db 行(未展开)→ 菜单:新建 Key / 刷新 / 清空 DB。
      fireEvent.contextMenu(screen.getByRole('button', { name: '数据库 db1' }))
      await waitFor(() =>{  expect(screen.getByText('刷新')).toBeTruthy() })
      // 菜单里的「新建 Key」(工具栏同名按钮用 aria-label,getByText 只取文本节点)。
      const menuNewKey = screen.getAllByText('新建 Key').find(el => el.closest('[role="menu"]') !== null)
      expect(menuNewKey).toBeDefined()
      fireEvent.click(menuNewKey!)
      await waitFor(() =>{  expect(screen.getByLabelText('目标 DB')).toBeTruthy() })
      // 弹窗的目标库默认该右键的 db(而非展开库/连接库)。
      expect((screen.getByLabelText<HTMLSelectElement>('目标 DB')).value).toBe('1')
      fireEvent.click(screen.getByText('取消'))
      // 清空 DB 走二次确认弹窗(目标库即右键的 db)。
      fireEvent.contextMenu(screen.getByRole('button', { name: '数据库 db1' }))
      fireEvent.click(screen.getByText('清空 DB'))
      await waitFor(() =>{  expect(screen.getByText(/将删除 db1 的全部 key/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('deletes a key after confirm, closes the value editor for that key, and guards on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 先打开值编辑器
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      // 取消删除 → 不调用
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_del', expect.anything())
      // 确认删除 → 调用 + toast + 值编辑器关闭(同 key)
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['user:1'] }) })
      await waitFor(() =>{  expect(screen.getByText('已删除:user:1')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.getByText('未选择 Key')).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('surfaces a delete failure toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri({ delError: new Error('del-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:del-boom/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('renames a key, closes on cancel/empty/same-name, and surfaces a rename failure toast', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      // 空名确认 → 关闭 renameBar,不调用
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: '' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_rename', expect.anything())
      // 同名确认 → 关闭,不调用
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_rename', expect.anything())
      // 重新打开 + 改名确认
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'user:9' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_rename', { connId: 'c1', oldKey: 'user:1', newKey: 'user:9' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已重命名')).toBeTruthy() })
    } finally {
      restore()
    }
    cleanup()
    // rename 失败 toast
    const invokeErr = installTauri({ renameError: new Error('ren-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:ren-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('flushes the DB only after typing the db number in the confirm modal, and surfaces a failure toast', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 打开确认弹窗:未输入序号时「清空」禁用,且未触发 flush。
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByLabelText('确认 db 序号')).toBeTruthy() })
      expect(screen.getByText(/将删除 db0 的全部 key/)).toBeTruthy()
      expect((screen.getByText<HTMLButtonElement>('清空')).disabled).toBe(true)
      expect(invoke).not.toHaveBeenCalledWith('db_redis_flush_db', expect.anything())
      // 取消:不 flush、弹窗关闭。
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('确认 db 序号')).toBeNull() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_flush_db', expect.anything())
      // 输入正确序号后才可确认(序号即目标库,文案与实际库强绑定)。
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      fireEvent.change(screen.getByLabelText('确认 db 序号'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('清空'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_flush_db', { connId: 'c1' }) })
      await waitFor(() =>{  expect(screen.getByText(/db0 已清空/)).toBeTruthy() })
      await waitFor(() =>{  expect(screen.queryByLabelText('确认 db 序号')).toBeNull() })
    } finally {
      restore()
    }
    cleanup()
    // 收起态清空:目标 = activeDb,flush 前连接已在该库 → 不再发 select;只刷新总数不取键。
    const invokeCollapsed = installTauri()
    const restoreCollapsed = stubInvoke(invokeCollapsed)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByLabelText('确认 db 序号')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('确认 db 序号'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('清空'))
      await waitFor(() =>{  expect(invokeCollapsed).toHaveBeenCalledWith('db_redis_flush_db', { connId: 'c1' }) })
      await waitFor(() =>{  expect(screen.getByText(/db0 已清空/)).toBeTruthy() })
      await waitFor(() =>{  expect(invokeCollapsed).toHaveBeenCalledWith('db_redis_db_size', { connId: 'c1' }) })
      expect(invokeCollapsed.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
      expect(invokeCollapsed.mock.calls.filter(c => c[0] === 'db_redis_select').length).toBe(0)
    } finally {
      restoreCollapsed()
    }
    cleanup()
    // flush 失败 toast(弹窗保留供重试)
    const invokeErr = installTauri({ flushError: new Error('fl-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByLabelText('确认 db 序号')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('确认 db 序号'), { target: { value: '0' } })
      fireEvent.keyDown(screen.getByLabelText('确认 db 序号'), { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:fl-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('creates a new key through the modal, cancels, and guards empty names', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 空 key → 创建按钮禁用
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      expect((screen.getByText<HTMLButtonElement>('创建')).disabled).toBe(true)
      // 取消
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('key 名')).toBeNull() })
      // 重新打开 + 输入 + 创建
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'newkey' } })
      fireEvent.change(screen.getByLabelText('值(string)'), { target: { value: "it's" } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SET newkey "it\'s"' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.queryByLabelText('key 名')).toBeNull() })
    } finally {
      restore()
    }
  })

  it('enforces the empty-key guard in createKey and surfaces a create failure toast', async () => {
    // 空 key 直接触发 createKey(按钮禁用但 fireEvent 会派发)→ 覆盖 `key === ''` 早退
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('创建'))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
    } finally {
      restore()
    }
    cleanup()
    // 创建失败 toast
    const invokeErr = installTauri({ executeError: new Error('create-boom') })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:create-boom/)).toBeTruthy() })
    } finally {
      restoreErr()
    }
  })

  it('creates a hash key with field/value through the type selector', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      // 选类型 hash → 出现字段名输入;值输入标签随类型变化。
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'hash' } })
      await waitFor(() =>{  expect(screen.getByLabelText('字段名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'h1' } })
      fireEvent.change(screen.getByLabelText('字段名'), { target: { value: 'f1' } })
      fireEvent.change(screen.getByLabelText('值(hash)'), { target: { value: 'v1' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET h1 f1 v1' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('creates a key into the chosen db, selecting it first when it differs', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('目标 DB')).toBeTruthy() })
      // 默认目标 = 当前展开库 db0;改选 db3 → 先 select 再 SET,并刷新 db3 计数。
      fireEvent.change(screen.getByLabelText('目标 DB'), { target: { value: '3' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k3' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SET k3 ""' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('blocks hash creation without a field and zset creation without a numeric score', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      // hash 缺字段名:创建按钮禁用。
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'hash' } })
      await waitFor(() =>{  expect(screen.getByLabelText('字段名')).toBeTruthy() })
      expect((screen.getByText<HTMLButtonElement>('创建')).disabled).toBe(true)
      // zset 分值非法:按钮可用但 createKey 拦截并提示,不下发命令。
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'zset' } })
      await waitFor(() =>{  expect(screen.getByLabelText('分值')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('分值'), { target: { value: 'abc' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText('zset 需要合法的数字分值')).toBeTruthy() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
    } finally {
      restore()
    }
  })

  describe('buildCreateKeyCommand(新建 key 按类型组命令)', () => {
    const base = { key: 'k', type: 'string', value: 'v', db: 0, field: '', score: '', ttl: '' }

    it('string → SET,list → RPUSH,set → SADD', () => {
      expect(buildCreateKeyCommand(base)).toEqual({ command: 'SET k v', ttl: null })
      expect(buildCreateKeyCommand({ ...base, type: 'list' })).toEqual({ command: 'RPUSH k v', ttl: null })
      expect(buildCreateKeyCommand({ ...base, type: 'set' })).toEqual({ command: 'SADD k v', ttl: null })
    })

    it('hash → HSET(缺字段名返回 null),zset → ZADD(非法分值返回 null)', () => {
      expect(buildCreateKeyCommand({ ...base, type: 'hash', field: 'f' })).toEqual({ command: 'HSET k f v', ttl: null })
      expect(buildCreateKeyCommand({ ...base, type: 'hash' })).toBeNull()
      expect(buildCreateKeyCommand({ ...base, type: 'zset', score: '1.5' })).toEqual({ command: 'ZADD k 1.5 v', ttl: null })
      expect(buildCreateKeyCommand({ ...base, type: 'zset', score: 'x' })).toBeNull()
      expect(buildCreateKeyCommand({ ...base, type: 'zset' })).toBeNull()
    })

    it('特殊字符 key/值走 redisQuote 转义', () => {
      expect(buildCreateKeyCommand({ ...base, key: 'my key', value: "it's" })).toEqual({ command: 'SET "my key" "it\'s"', ttl: null })
    })

    it('stream → XADD(服务器分配 id,缺字段名返回 null)', () => {
      expect(buildCreateKeyCommand({ ...base, type: 'stream', field: 'f' })).toEqual({ command: 'XADD k * f v', ttl: null })
      expect(buildCreateKeyCommand({ ...base, type: 'stream' })).toBeNull()
      expect(buildCreateKeyCommand({ ...base, type: 'stream', field: 'f', ttl: '30' })).toEqual({ command: 'XADD k * f v', ttl: 30 })
    })

    it('TTL:string 拼进 SET EX,其它类型经返回值带出(由调用方补 EXPIRE)', () => {
      expect(buildCreateKeyCommand({ ...base, ttl: '60' })).toEqual({ command: 'SET k v EX 60', ttl: 60 })
      expect(buildCreateKeyCommand({ ...base, type: 'hash', field: 'f', ttl: '30' })).toEqual({ command: 'HSET k f v', ttl: 30 })
      // 非法 TTL 按无 TTL 处理(组件层已先用 parseNewKeyTtl 拦截提示)。
      expect(buildCreateKeyCommand({ ...base, ttl: 'abc' })).toEqual({ command: 'SET k v', ttl: null })
    })
  })

  describe('isMutatingRedisCommand(CLI 命令是否改键空间)', () => {
    it('写命令命中,只读命令不命中(只读命令免全库重扫)', () => {
      for (const cmd of ['SET k v', 'set k v', '  HSET h f v', 'DEL k', 'EXPIRE k 60', 'XADD s * f v', 'FLUSHDB', 'LPUSH l v']) {
        expect(isMutatingRedisCommand(cmd), cmd).toBe(true)
      }
      for (const cmd of ['GET k', 'KEYS *', 'HGETALL h', 'TTL k', 'TYPE k', 'SCAN 0', 'PING', 'INFO', 'LRANGE l 0 -1', 'XLEN s', '']) {
        expect(isMutatingRedisCommand(cmd), cmd).toBe(false)
      }
    })
  })

  describe('valuePlaceholder(新建 key 对话框值占位符)', () => {
    it('按类型给出填写说明', () => {
      expect(valuePlaceholder('string')).toBe('值(string)')
      expect(valuePlaceholder('hash')).toBe('值(hash)')
      expect(valuePlaceholder('stream')).toBe('首条目的字段值')
      expect(valuePlaceholder('list')).toBe('首个成员')
      expect(valuePlaceholder('zset')).toBe('首个成员')
    })
  })

  describe('parseNewKeyTtl(新建 key 的 TTL 输入)', () => {
    it('空 = 持久化;正整数 = 秒数;0/负数/小数/非数字一律 invalid', () => {
      // 0 必须拒绝:EXPIRE key 0 是「立即删除」,SET EX 0 是服务端报错。
      expect(parseNewKeyTtl('')).toBeNull()
      expect(parseNewKeyTtl('  ')).toBeNull()
      expect(parseNewKeyTtl('60')).toBe(60)
      expect(parseNewKeyTtl('0')).toBe('invalid')
      expect(parseNewKeyTtl('-1')).toBe('invalid')
      expect(parseNewKeyTtl('1.5')).toBe('invalid')
      expect(parseNewKeyTtl('abc')).toBe('invalid')
    })
  })

  it('runs a CLI command on Enter and via the execute button, refreshing the expanded DB', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 空命令 Enter → 早退
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      // 只读命令不改变键空间:执行后不重扫(旧版无脑刷新,大库每条命令都卡)。
      const beforeRead = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'GET foo' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'GET foo' }) })
      await waitFor(() =>{  expect(screen.getByText('OK')).toBeTruthy() })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(beforeRead)
      // 写命令才刷新:展开态下命令后重扫该 db 的键(基线取在执行前)。
      const beforeWrite = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'SET foo bar' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SET foo bar' }) })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(beforeWrite) })
    } finally {
      restore()
    }
  })

  it('dumps a non-object command result via String() and refreshes only the size when collapsed', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: 123, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // INCR 是写命令(返回值仍是标量 123,覆盖 String() 路径)。
      fireEvent.change(input, { target: { value: 'INCR counter' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('123')).toBeTruthy() })
      // 未展开任何 db:写命令后只刷当前库总数,不取键(保持懒加载)。
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_db_size', { connId: 'c1' }) })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(0)
    } finally {
      restore()
    }
  })

  it('dumps an object CLI result via JSON.stringify', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: { ok: 1 }, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'HGETALL k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText(/"ok": 1/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('shows an execute error field, handles a null result, and surfaces a runCli rejection', async () => {
    // execute 返回 error 字段 → 直接展示。
    const invokeErr = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: null, durationMs: 1, error: 'internal-err' })
      return Promise.resolve(null)
    })
    const restoreErr = stubInvoke(invokeErr)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('internal-err')).toBeTruthy() })
    } finally {
      restoreErr()
    }
    cleanup()
    // null 结果 → `?? ''` 回退,输出空串(不渲染 pre);非 Enter 键不触发。
    const invokeNull = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.resolve({ result: undefined, durationMs: 1 })
      return Promise.resolve(null)
    })
    const restoreNull = stubInvoke(invokeNull)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input2 = screen.getByLabelText('命令输入')
      fireEvent.keyDown(input2, { key: 'a' })
      expect(invokeNull).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
      fireEvent.change(input2, { target: { value: 'PING' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(invokeNull).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'PING' }) })
      expect(screen.queryByText('undefined')).toBeNull()
    } finally {
      restoreNull()
    }
    cleanup()
    // execute 拒绝 → 输出错误串
    const invokeRej = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0 })
      if (cmd === 'db_redis_execute') return Promise.reject(new Error('plain-exec'))
      return Promise.resolve(null)
    })
    const restoreRej = stubInvoke(invokeRej)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input3 = screen.getByLabelText('命令输入')
      fireEvent.change(input3, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('plain-exec')).toBeTruthy() })
    } finally {
      restoreRej()
    }
  })

  it('closes via the header close button and calls onClose', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    const onClose = vi.fn()
    try {
      renderWorkbench(asset, onClose)
      await expandDb0WithKeys()
      fireEvent.click(screen.getByText('关闭'))
      expect(onClose).toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench failure variants', () => {
  it('surfaces a db-size failure during the expand refresh', async () => {
    const invoke = installTauri({ sizeError: new Error('size-err') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:size-err/)).toBeTruthy() })
      // 键列表不受 db_size 失败影响,照常展示(点开文件夹)。
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('surfaces raw-string rejections (non-Error) as toast/error text', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const raw = (msg: string) => Promise.reject(msg)
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_scan': return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
        case 'db_redis_db_size': return raw('raw-size')
        case 'db_redis_select': return raw('raw-sel')
        case 'db_redis_del': return raw('raw-del')
        case 'db_redis_rename': return raw('raw-ren')
        case 'db_redis_flush_db': return raw('raw-fl')
        case 'db_redis_execute': return raw('raw-exec')
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      // 展开 db0:db_size 裸串拒绝 → toast;scan 成功 → 点开文件夹后键行出现。
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText(/获取键数失败:raw-size/)).toBeTruthy() })
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // delete / rename / flush 裸串拒绝。
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:raw-del/)).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:raw-ren/)).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByLabelText('确认 db 序号')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('确认 db 序号'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('清空'))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:raw-fl/)).toBeTruthy() })
      // CLI execute 裸串拒绝 → 输出串。
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'GET k' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('raw-exec')).toBeTruthy() })
      // create execute 裸串拒绝 → toast。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:raw-exec/)).toBeTruthy() })
      // select 裸串拒绝(放最后:切换失败会收起展开态)。
      clickDb(4)
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:raw-sel/)).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db4' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('keeps the newer expand when a stale SELECT fails (race guard)', async () => {
    let rejectSelect!: (e: unknown) => void
    const selectGate = new Promise<never>((_, reject) => { rejectSelect = reject })
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_select') return selectGate
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(3)
      await waitFor(() =>{  expect(screen.getByText('加载键…')).toBeTruthy() })
      // select(3) 挂起时用户改点已是当前库的 db0(无需 select,直接加载)。
      clickDb(0)
      const folder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(folder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // 迟到的 select 失败:回退守卫看到当前展开已是 db0,不覆盖它。
      rejectSelect('sel-race')
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:sel-race/)).toBeTruthy() })
      expect(screen.getByRole('button', { name: '数据库 db3' }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByTitle('user:1')).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('surfaces failure text for delete/rename/flush/create', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 1 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      if (cmd === 'db_redis_del') return Promise.reject(new Error('plain-del'))
      if (cmd === 'db_redis_rename') return Promise.reject(new Error('plain-ren'))
      if (cmd === 'db_redis_flush_db') return Promise.reject(new Error('plain-fl'))
      if (cmd === 'db_redis_execute') return Promise.reject(new Error('plain-exec'))
      return Promise.resolve(null)
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // delete 失败
      fireEvent.click(screen.getByLabelText('删除 user:1'))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:plain-del/)).toBeTruthy() })
      // rename 失败
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('新 key 名'), { target: { value: 'n' } })
      fireEvent.click(screen.getByText('确认'))
      await waitFor(() =>{  expect(screen.getByText(/重命名失败:plain-ren/)).toBeTruthy() })
      // flush 失败
      fireEvent.click(screen.getByRole('button', { name: '清空 DB' }))
      await waitFor(() =>{  expect(screen.getByLabelText('确认 db 序号')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('确认 db 序号'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('清空'))
      await waitFor(() =>{  expect(screen.getByText(/清空 DB 失败:plain-fl/)).toBeTruthy() })
      // create(execute) 失败:先关掉 flush 确认弹窗(失败时保持打开便于重试,
      // 页面同时可能还有重命名条,故按弹窗容器收敛「取消」按钮)
      const flushField = screen.getByLabelText('确认 db 序号')
      let flushModal: HTMLElement | null = flushField
      while (flushModal !== null && within(flushModal).queryByText('清空') === null) flushModal = flushModal.parentElement
      if (flushModal === null) throw new Error('flush modal not found')
      fireEvent.click(within(flushModal).getByText('取消'))
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/创建失败:plain-exec/)).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('keeps the value editor open when deleting a different key', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 打开 user:1 的值编辑器
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      // sess:2 在默认收起的 sess 文件夹下,先点开它。
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      // 删除不同的 key(sess:2)→ openValue(user:1) 保留下 (cur?.key !== key → cur)
      fireEvent.click(screen.getByLabelText('删除 sess:2'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['sess:2'] }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.objectContaining({ key: 'user:1' })) })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('cancels an in-progress rename via the cancel button', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '重命名 user:1' }))
      await waitFor(() =>{  expect(screen.getByLabelText('新 key 名')).toBeTruthy() })
      fireEvent.click(screen.getByText('取消'))
      await waitFor(() =>{  expect(screen.queryByLabelText('新 key 名')).toBeNull() })
    } finally {
      restore()
    }
  })

  it('follows the SCAN cursor across pages to load every key, not just the first page', async () => {
    // 第一页返回 cursor=5 且只带 user:1;第二页 cursor=0 带回 sess:2。修复前仅取一页,
    // 只会看到 user:1;现在连续 SCAN 直到游标归零,两个 key 都加载。
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') {
        const cursor = (args?.cursor as number) ?? 0
        if (cursor === 0) return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 5, total: 2 })
        return Promise.resolve({ keys: [keyInfo('sess:2', 'hash')], cursor: 0, total: 2 })
      }
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // 两页都请求过(游标跟随而非只 GET 一页)。
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      const scanCalls = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan')
      expect(scanCalls.length).toBe(2)
    } finally {
      restore()
    }
  })

  it('renders a per-key TTL badge from the SCAN payload (∞ when persistent)', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({
        keys: [
          { key: 'user:1', type: 'string', ttl: -1 },
          { key: 'user:2', type: 'string', ttl: 30 },
          { key: 'user:3', type: 'string', ttl: 7200 },
        ],
        cursor: 0, total: 3,
      })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      const userFolder = await waitFor(() =>{  return screen.getByLabelText('文件夹 user') })
      fireEvent.click(userFolder)
      await waitFor(() =>{  expect(screen.getByTitle('user:1')).toBeTruthy() })
      // -1 → ∞;30 → 30;7200(≥1h)→ 2h
      expect(screen.getByTitle('user:1').parentElement?.querySelector('[class*="ttlBadge"]')?.textContent).toBe('∞')
      expect(screen.getByTitle('user:2').parentElement?.querySelector('[class*="ttlBadge"]')?.textContent).toBe('30')
      expect(screen.getByTitle('user:3').parentElement?.querySelector('[class*="ttlBadge"]')?.textContent).toBe('2h')
    } finally {
      restore()
    }
  })

  it('walks CLI history with ArrowUp/ArrowDown and dedupes consecutive repeats', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 执行两条命令(第二条与第一条重复 → 历史只留一条)。
      fireEvent.change(input, { target: { value: 'GET a' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(screen.getByText('OK')).toBeTruthy() })
      fireEvent.change(input, { target: { value: 'GET a' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_execute').length).toBe(2) })
      fireEvent.change(input, { target: { value: 'GET b' } })
      fireEvent.click(screen.getByText('执行'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_execute').length).toBe(3) })
      // ↑ → 最近一条(GET b);再 ↑ → GET a;再 ↑ 仍在最早一条。
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      await waitFor(() =>{  expect((input as HTMLInputElement).value).toBe('GET b') })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      await waitFor(() =>{  expect((input as HTMLInputElement).value).toBe('GET a') })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect((input as HTMLInputElement).value).toBe('GET a')
      // ↓ → 回到 GET b;再 ↓ → 越过最新一条,回到空行。
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      await waitFor(() =>{  expect((input as HTMLInputElement).value).toBe('GET b') })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      await waitFor(() =>{  expect((input as HTMLInputElement).value).toBe('') })
    } finally {
      restore()
    }
  })

  it('distinguishes "no keys" from "search matched nothing" in the db block', async () => {
    // 默认 stub 会返回 user:1 / sess:2,这里改用空 SCAN 才能看到空态文案。
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 0 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [], cursor: 0, total: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByText('暂无 key。')).toBeTruthy() })
      // 有匹配词但扫不到 key → 搜索无匹配文案。
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: 'zzz' } })
      await waitFor(() =>{  expect(screen.getByText('搜索无匹配 key。')).toBeTruthy() })
    } finally {
      restore()
    }
  })
})

describe('RedisWorkbench 增强(初始库 / 类型过滤 / 批量删除 / 分析页签 / 新建 TTL)', () => {
  it('connects to the initial db from asset config (0-15 int only, else falls back to 0)', async () => {
    // config.db = 3:建连参数带 db:3,头栏直接显示 db3(activeDb 同步)。
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench({ ...asset, config: { host: 'h', port: 6379, db: 3 } })
      await waitConnected()
      expect(invoke).toHaveBeenCalledWith('db_redis_connect', { params: { host: 'h', port: 6379, db: 3, ssl: false } })
      expect(screen.getByTestId('redis-head-badge').textContent).toBe('db3')
    } finally {
      restore()
    }
    // 非法值一律回落 0:越界 / 非整数 / 负数。
    for (const bad of [99, 1.5, -1]) {
      cleanup()
      const invokeBad = installTauri()
      const restoreBad = stubInvoke(invokeBad)
      try {
        renderWorkbench({ ...asset, config: { host: 'h', port: 6379, db: bad } })
        await waitConnected()
        expect(invokeBad).toHaveBeenCalledWith('db_redis_connect', { params: { host: 'h', port: 6379, db: 0, ssl: false } })
      } finally {
        restoreBad()
      }
    }
  })

  it('filters keys by type via scan_all (per-db), falling back to paged SCAN on 全部', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 选中 hash:改走 scan_all(服务端过滤的一次性全量),不再分页 SCAN。
      fireEvent.change(screen.getByLabelText('类型过滤'), { target: { value: 'hash' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan_all', { connId: 'c1', match: undefined, typeFilter: 'hash' }) })
      // scan_all 结果(sess:2 hash)直接渲染;分页结果 user:1 被替换掉。
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 sess')).toBeTruthy() })
      expect(screen.queryByLabelText('文件夹 user')).toBeNull()
      // 叠加搜索词:防抖后 scan_all 带 match(非空 match 臂)。
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: 'sess' } })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan_all', { connId: 'c1', match: '*sess*', typeFilter: 'hash' }) })
      // 清空搜索词再切回「全部」:恢复 redisScanAccumulate 分页加载(防抖只保留
      // 最后一次变更,中途的 scan_all 重扫被 clearTimeout 取代)。
      fireEvent.change(screen.getByLabelText('搜索 key'), { target: { value: '' } })
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(screen.getByLabelText('类型过滤'), { target: { value: '' } })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBeGreaterThan(scansBefore) })
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('shows the filtered empty state when scan_all returns nothing for the type filter', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 2 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
      if (cmd === 'db_redis_scan_all') return Promise.resolve({ keys: [], cursor: 0, total: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('类型过滤'), { target: { value: 'zset' } })
      // 有过滤条件但无结果 → 与搜索无匹配同款文案。
      await waitFor(() =>{  expect(screen.getByText('搜索无匹配 key。')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('batch-deletes selected keys (leaf + folder checkboxes), closing the editor only when its key is deleted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 打开 user:1 的值编辑器;先只删 sess:2(编辑器保留)。
      fireEvent.click(screen.getByTitle('user:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', expect.anything()) })
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      fireEvent.click(screen.getByLabelText('选择 sess:2'))
      const delBtn = await waitFor(() =>{  return screen.getByTestId('redis-delete-selected') })
      expect(delBtn.textContent).toContain('1')
      // 取消批量删除:不发 del,勾选保留。
      fireEvent.click(delBtn)
      expect(invoke).not.toHaveBeenCalledWith('db_redis_del', expect.anything())
      expect(screen.getByTestId('redis-delete-selected')).toBeTruthy()
      // 确认删除。
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByTestId('redis-delete-selected'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['sess:2'] }) })
      await waitFor(() =>{  expect(screen.getByText('已删除 1 个 key')).toBeTruthy() })
      // 刷新后勾选清空(按钮消失);user:1 编辑器仍开着。
      await waitFor(() =>{  expect(screen.queryByTestId('redis-delete-selected')).toBeNull() })
      expect(screen.queryByText('未选择 Key')).toBeNull()
      // 文件夹勾选 = 其下全部叶子(user 文件夹下即 user:1);删除后编辑器关闭。
      fireEvent.click(screen.getByLabelText('选择文件夹 user'))
      const delBtn2 = await waitFor(() =>{  return screen.getByTestId('redis-delete-selected') })
      expect(delBtn2.textContent).toContain('1')
      fireEvent.click(delBtn2)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_del', { connId: 'c1', keys: ['user:1'] }) })
      await waitFor(() =>{  expect(screen.getByText('未选择 Key')).toBeTruthy() })
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('batch delete failure toasts and keeps the selection for retry', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = installTauri({ delError: new Error('bdel-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByLabelText('选择 user:1'))
      fireEvent.click(await waitFor(() =>{  return screen.getByTestId('redis-delete-selected') }))
      await waitFor(() =>{  expect(screen.getByText(/删除失败:bdel-boom/)).toBeTruthy() })
      // 失败不清勾选,按钮仍在供重试。
      expect(screen.getByTestId('redis-delete-selected')).toBeTruthy()
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('toggles leaf and folder selection off again (button disappears)', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // 叶子勾选 → 按钮出现;取消勾选 → 消失。
      fireEvent.click(screen.getByLabelText('选择 user:1'))
      await waitFor(() =>{  expect(screen.getByTestId('redis-delete-selected')).toBeTruthy() })
      fireEvent.click(screen.getByLabelText('选择 user:1'))
      await waitFor(() =>{  expect(screen.queryByTestId('redis-delete-selected')).toBeNull() })
      // 文件夹勾选 → 全选其下叶子(文件夹勾选框随之置中);再取消 → 全清。
      fireEvent.click(screen.getByLabelText('文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTitle('sess:2')).toBeTruthy() })
      fireEvent.click(screen.getByLabelText('选择文件夹 sess'))
      await waitFor(() =>{  expect(screen.getByTestId('redis-delete-selected')).toBeTruthy() })
      expect(screen.getByLabelText<HTMLInputElement>('选择文件夹 sess').checked).toBe(true)
      fireEvent.click(screen.getByLabelText('选择文件夹 sess'))
      await waitFor(() =>{  expect(screen.queryByTestId('redis-delete-selected')).toBeNull() })
    } finally {
      restore()
    }
  })

  it('creates a string key with a TTL (SET … EX) and a hash key with TTL (HSET + EXPIRE)', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      // string + TTL 60:SET 内拼 EX,不追加 EXPIRE。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'tk' } })
      fireEvent.change(screen.getByLabelText('值(string)'), { target: { value: 'v' } })
      fireEvent.change(screen.getByLabelText('TTL(秒)'), { target: { value: '60' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'SET tk v EX 60' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_execute').length).toBe(1)
      // hash + TTL 30:HSET 后追加 EXPIRE。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'hash' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'hk' } })
      fireEvent.change(screen.getByLabelText('字段名'), { target: { value: 'f' } })
      fireEvent.change(screen.getByLabelText('值(hash)'), { target: { value: 'v' } })
      fireEvent.change(screen.getByLabelText('TTL(秒)'), { target: { value: '30' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'HSET hk f v' }) })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_execute', { connId: 'c1', command: 'EXPIRE hk 30' }) })
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('rejects a non-positive-integer TTL in the new-key modal without issuing commands', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      await waitFor(() =>{  expect(screen.getByLabelText('key 名')).toBeTruthy() })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k' } })
      fireEvent.change(screen.getByLabelText('TTL(秒)'), { target: { value: '0' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText(/TTL 必须是正整数/)).toBeTruthy() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.anything())
    } finally {
      restore()
    }
  })

  it('analysis tab: server info / slowlog render, slowlog reset, bigkey scan opens the key, memory analysis renders', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_db_size': return Promise.resolve({ size: 2 })
        case 'db_redis_scan': return Promise.resolve({ keys: [keyInfo('user:1')], cursor: 0 })
        case 'db_redis_get_value': return Promise.resolve({ key: 'big:1', type: 'string', value: 'x', ttl: -1 })
        case 'db_redis_info': return Promise.resolve('# Server\nredis_version:7.0.0\n\n# Memory\nused_memory:2048\n')
        case 'db_redis_slowlog_get': return Promise.resolve([{ id: 1, duration: 12345, timestamp: 1700000000, command: 'KEYS *' }])
        case 'db_redis_slowlog_reset': return Promise.resolve(null)
        case 'db_redis_bigkey_scan': return Promise.resolve([
          { key: 'big:1', type: 'string', size: 99999, length: 0 },
          { key: 'big:hash', type: 'hash', size: 0, length: 5000 },
        ])
        case 'db_redis_memory_analysis': return Promise.resolve([{ prefix: 'user:*', keys: 10, memory: 4096, percentage: 80 }])
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      // 进入「分析」页签:INFO 与慢日志自动加载。
      fireEvent.click(screen.getByRole('tab', { name: '分析' }))
      await waitFor(() =>{  expect(screen.getByText('redis_version')).toBeTruthy() })
      expect(screen.getByText('Server')).toBeTruthy()
      expect(screen.getByText('Memory')).toBeTruthy()
      expect(screen.getByText('used_memory')).toBeTruthy()
      await waitFor(() =>{  expect(screen.getByText('KEYS *')).toBeTruthy() })
      expect(screen.getByText('12.3 ms')).toBeTruthy()
      // 清空慢日志:confirm 后 reset + 重新加载。
      fireEvent.click(screen.getByText('清空慢日志'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_slowlog_reset', { connId: 'c1' }) })
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_slowlog_get').length).toBe(2) })
      // BigKey 扫描:改 match、清空阈值(→ undefined,交 sidecar 缺省)。
      fireEvent.change(screen.getByLabelText('BigKey MATCH 模式'), { target: { value: 'big:*' } })
      fireEvent.change(screen.getByLabelText('string 字节阈值'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText('集合成员数阈值'), { target: { value: '' } })
      fireEvent.click(screen.getByText('开始扫描'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_bigkey_scan', { connId: 'c1', match: 'big:*', stringThreshold: undefined, memberThreshold: undefined }) })
      await waitFor(() =>{  expect(screen.getByText('99,999 B')).toBeTruthy() })
      expect(screen.getByText('5,000 成员')).toBeTruthy()
      // 内存分析:前缀聚合表。
      fireEvent.click(screen.getByText('开始分析'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_memory_analysis', { connId: 'c1', match: undefined, sampleSize: undefined }) })
      await waitFor(() =>{  expect(screen.getByText('user:*')).toBeTruthy() })
      expect(screen.getByText('80.0%')).toBeTruthy()
      // 点击 BigKey 行:切回「键值」页并打开该 key。
      fireEvent.click(screen.getByText('big:1'))
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_get_value', { connId: 'c1', key: 'big:1' }) })
      expect((screen.getByRole('tab', { name: '键值' })).getAttribute('aria-selected')).toBe('true')
      expect(screen.queryByText('服务器信息')).toBeNull()
    } finally {
      restore()
      confirmSpy.mockRestore()
    }
  })

  it('analysis tab: per-block errors with working retry, and slowlog reset cancel/failure', async () => {
    let infoCalls = 0
    let slowCalls = 0
    let bigkeyCalls = 0
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_info':
          infoCalls += 1
          // 第一次失败,点「重新加载」后成功。
          return infoCalls === 1 ? Promise.reject(new Error('info-boom')) : Promise.resolve('# Server\nredis_version:7.0.0\n')
        case 'db_redis_slowlog_get':
          slowCalls += 1
          // 第一次失败(覆盖慢日志加载 catch),「重新加载」后成功。
          return slowCalls === 1 ? Promise.reject(new Error('slow-boom')) : Promise.resolve([{ id: 1, duration: 1000, timestamp: 1700000000, command: 'GET k' }])
        case 'db_redis_slowlog_reset': return Promise.reject(new Error('reset-boom'))
        case 'db_redis_bigkey_scan':
          bigkeyCalls += 1
          return bigkeyCalls === 1 ? Promise.reject(new Error('big-boom')) : Promise.resolve([])
        case 'db_redis_memory_analysis': return Promise.reject('mem-raw')
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('tab', { name: '分析' }))
      // INFO 错误态 + 重试恢复。
      await waitFor(() =>{  expect(screen.getByText(/加载失败:info-boom/)).toBeTruthy() })
      fireEvent.click(within(screen.getByLabelText('服务器信息')).getByText('重新加载'))
      await waitFor(() =>{  expect(screen.getByText('redis_version')).toBeTruthy() })
      expect(infoCalls).toBe(2)
      // 慢日志错误态 + 重试恢复。
      await waitFor(() =>{  expect(screen.getByText(/加载失败:slow-boom/)).toBeTruthy() })
      fireEvent.click(within(screen.getByLabelText('慢日志')).getByText('重新加载'))
      await waitFor(() =>{  expect(screen.getByText('GET k')).toBeTruthy() })
      expect(slowCalls).toBe(2)
      // BigKey 错误态 + 重新加载后成功(空结果)。
      fireEvent.click(screen.getByText('开始扫描'))
      await waitFor(() =>{  expect(screen.getByText(/加载失败:big-boom/)).toBeTruthy() })
      fireEvent.click(within(screen.getByLabelText('BigKey 扫描')).getByText('重新加载'))
      await waitFor(() =>{  expect(screen.getByText('未发现大 key。')).toBeTruthy() })
      expect(bigkeyCalls).toBe(2)
      // 内存分析裸字符串 reject(非 Error)→ String 兜底;重新加载仍失败。
      fireEvent.click(screen.getByText('开始分析'))
      await waitFor(() =>{  expect(screen.getByText(/加载失败:mem-raw/)).toBeTruthy() })
      fireEvent.click(within(screen.getByLabelText('内存分析')).getByText('重新加载'))
      await waitFor(() =>{  expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_memory_analysis').length).toBe(2) })
      // 慢日志已恢复:取消清空(confirm false)不发 reset。
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      fireEvent.click(screen.getByText('清空慢日志'))
      expect(invoke).not.toHaveBeenCalledWith('db_redis_slowlog_reset', expect.anything())
      // 确认但 reset 失败 → 慢日志块错误态。
      confirmSpy.mockReturnValue(true)
      fireEvent.click(screen.getByText('清空慢日志'))
      await waitFor(() =>{  expect(screen.getByText(/加载失败:reset-boom/)).toBeTruthy() })
      confirmSpy.mockRestore()
    } finally {
      restore()
    }
  })

  it('analysis tab: empty slowlog / empty bigkey / empty memory states and loading hints', async () => {
    let releaseBigkey!: (v: unknown) => void
    const bigkeyGate = new Promise<unknown>((res) => { releaseBigkey = res })
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_info': return Promise.resolve('# Server\nredis_version:7.0.0\n')
        case 'db_redis_slowlog_get': return Promise.resolve([])
        case 'db_redis_bigkey_scan': return bigkeyGate
        case 'db_redis_memory_analysis': return Promise.resolve([])
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      fireEvent.click(screen.getByRole('tab', { name: '分析' }))
      // 空慢日志:文案 + 清空钮禁用。
      await waitFor(() =>{  expect(screen.getByText('无慢查询记录。')).toBeTruthy() })
      expect((screen.getByText<HTMLButtonElement>('清空慢日志')).disabled).toBe(true)
      // BigKey 扫描在途:加载提示 + 按钮禁用;空结果 → 「未发现大 key。」。
      fireEvent.click(screen.getByText('开始扫描'))
      await waitFor(() =>{  expect(screen.getByText('扫描中…')).toBeTruthy() })
      expect((screen.getByText<HTMLButtonElement>('开始扫描')).disabled).toBe(true)
      releaseBigkey([])
      await waitFor(() =>{  expect(screen.getByText('未发现大 key。')).toBeTruthy() })
      // 内存分析空结果。
      fireEvent.click(screen.getByText('开始分析'))
      await waitFor(() =>{  expect(screen.getByText('暂无数据(当前库无 key)。')).toBeTruthy() })
      // 切回「键值」页签:分析面板卸载。
      fireEvent.click(screen.getByRole('tab', { name: '键值' }))
      await waitFor(() =>{  expect(screen.getByText('未选择 Key')).toBeTruthy() })
    } finally {
      restore()
    }
  })
})
describe('parseRedisInfo(INFO 文本按 section 分组)', () => {
  it('groups k:v lines under # sections, skipping blanks, garbage and pre-section lines', () => {
    const sections = parseRedisInfo('orphan:1\n# Server\nredis_version:7.0.0\n\ngarbage-line\n# Memory\nused_memory:1024\n')
    expect(sections).toEqual([
      { title: 'Server', entries: [['redis_version', '7.0.0']] },
      { title: 'Memory', entries: [['used_memory', '1024']] },
    ])
    expect(parseRedisInfo('')).toEqual([])
  })

  it('tolerates CRLF line endings and values containing colons', () => {
    const sections = parseRedisInfo('# Server\r\nrun_id:abc:def\r\n')
    expect(sections[0]?.entries[0]).toEqual(['run_id', 'abc:def'])
  })
})

describe('parseCliSelect(CLI 的 SELECT 解析)', () => {
  it('returns null for non-SELECT commands, invalid for bad args, and the db for valid ones', () => {
    expect(parseCliSelect('')).toBeNull()
    expect(parseCliSelect('GET k')).toBeNull()
    expect(parseCliSelect('select')).toBe('invalid')
    expect(parseCliSelect('SELECT 1 2')).toBe('invalid')
    expect(parseCliSelect('SELECT x')).toBe('invalid')
    expect(parseCliSelect('SELECT -1')).toBe('invalid')
    expect(parseCliSelect('SELECT 99')).toBe('invalid')
    expect(parseCliSelect('SELECT 3')).toBe(3)
  })
})

describe('RedisWorkbench CLI SELECT 与键树形态', () => {
  it('routes CLI SELECT through redisSelect with UI sync, cache hits, and invalid/already-there guards', async () => {
    const invoke = installTauri()
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      // 已在 db0 且 db0 已展开 → 不 select 不 execute。
      fireEvent.change(input, { target: { value: 'SELECT 0' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已在 db0')).toBeTruthy() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_select', expect.anything())
      // 非法 db 序号 → 提示,不下发任何命令。
      fireEvent.change(input, { target: { value: 'SELECT 99' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText(/无效的 db 序号/)).toBeTruthy() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_select', expect.anything())
      // SELECT 3:走 redisSelect(不透传 execute),展开并加载 db3。
      fireEvent.change(input, { target: { value: 'SELECT 3' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已切换到 db3')).toBeTruthy() })
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 3 }) })
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      expect(invoke).not.toHaveBeenCalledWith('db_redis_execute', expect.objectContaining({ command: 'SELECT 3' }))
      // 切回 db0 再 SELECT 3:db3 有完整缓存(match/typeFilter 一致),不重复 SCAN。
      clickDb(0)
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_select', { connId: 'c1', db: 0 }) })
      const scansBefore = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'SELECT 3' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已切换到 db3')).toBeTruthy() })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore)
    } finally {
      restore()
    }
  })

  it('surfaces a CLI SELECT failure in the CLI output', async () => {
    const invoke = installTauri({ selectError: new Error('cli-sel-boom') })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await expandDb0WithKeys()
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      fireEvent.change(input, { target: { value: 'SELECT 5' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText(/切换 DB 失败:cli-sel-boom/)).toBeTruthy() })
    } finally {
      restore()
    }
  })

  it('CLI SELECT cache variants: same-db skip, already-expanded skip, and partial-cache continuation', async () => {
    // scanIncomplete=true 时 scan 游标永不归零:初始加载撞 redisScanAccumulate 的
    // maxPages 上限,落成「部分缓存」(complete=false、cursor=7);翻回 false 后
    // 续传一页即归零(避免测试收尾后仍有在途的 400 页循环)。
    let scanIncomplete = false
    const invoke = vi.fn((cmd: string) => {
      switch (cmd) {
        case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
        case 'db_redis_db_size': return Promise.resolve({ size: 1 })
        case 'db_redis_scan': return Promise.resolve(scanIncomplete
          ? { keys: [keyInfo('user:1')], cursor: 7, total: 2 }
          : { keys: [keyInfo('user:1')], cursor: 0, total: 1 })
        default: return Promise.resolve(null)
      }
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      // ① 新建 key 到 db1:切库 + 展开 db1 并加载其键(修库漂移后与 CLI SELECT
      //  同路径,不再「连接在 db1、UI 停在 db0」)。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      fireEvent.change(screen.getByLabelText('目标 DB'), { target: { value: '1' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k1' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.getByRole('button', { name: '数据库 db1' }).getAttribute('aria-expanded')).toBe('true') })
      // ② CLI SELECT 1:已在 db1 且已展开 → 直接提示,不 select 不重扫。
      fireEvent.click(screen.getByRole('button', { name: 'CLI' }))
      const input = screen.getByLabelText('命令输入')
      const selectsBefore2 = invoke.mock.calls.filter(c => c[0] === 'db_redis_select').length
      const scansBefore2 = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'SELECT 1' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已在 db1')).toBeTruthy() })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_select').length).toBe(selectsBefore2)
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore2)
      // ③ 新建 key 回 db0:切库 + 展开 db0;db0 缓存完整 → 不重扫。
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      fireEvent.change(screen.getByLabelText('目标 DB'), { target: { value: '0' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k0' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      await waitFor(() =>{  expect(screen.getByRole('button', { name: '数据库 db0' }).getAttribute('aria-expanded')).toBe('true') })
      // ④ CLI SELECT 1:active=0 要 select,但 db1 已展开且缓存完整 → 不重扫。
      const selectsBefore4 = invoke.mock.calls.filter(c => c[0] === 'db_redis_select').length
      const scansBefore4 = invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length
      fireEvent.change(input, { target: { value: 'SELECT 1' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已切换到 db1')).toBeTruthy() })
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_select').length).toBe(selectsBefore4 + 1)
      expect(invoke.mock.calls.filter(c => c[0] === 'db_redis_scan').length).toBe(scansBefore4)
      // ⑤ db2 落成部分缓存(游标不归零)后收起;新建 key 回 db0 再 SELECT 2:
      //  缓存命中但 incomplete → 从游标 7 自动续传一批。
      scanIncomplete = true
      clickDb(2)
      await waitFor(() =>{  expect(screen.getByLabelText('文件夹 user')).toBeTruthy() })
      clickDb(2) // 收起(缓存保留,activeDb 停在 db2)
      scanIncomplete = false
      fireEvent.click(screen.getByRole('button', { name: '新建 Key' }))
      fireEvent.change(screen.getByLabelText('目标 DB'), { target: { value: '0' } })
      fireEvent.change(screen.getByLabelText('key 名'), { target: { value: 'k0b' } })
      fireEvent.click(screen.getByText('创建'))
      await waitFor(() =>{  expect(screen.getByText('Key 已创建')).toBeTruthy() })
      fireEvent.change(input, { target: { value: 'SELECT 2' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() =>{  expect(screen.getByText('已切换到 db2')).toBeTruthy() })
      // 续传从缓存游标 7 起(而非从头 0 重扫)。
      await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('db_redis_scan', expect.objectContaining({ connId: 'c1', cursor: 7 })) })
    } finally {
      restore()
    }
  })

  it('renders root-level leaf keys and nested folders side by side', async () => {
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'db_redis_connect') return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      if (cmd === 'db_redis_db_size') return Promise.resolve({ size: 3 })
      if (cmd === 'db_redis_scan') return Promise.resolve({ keys: [keyInfo('plain'), keyInfo('a:b:c'), keyInfo('a:b:d')], cursor: 0 })
      return Promise.resolve(null)
    })
    const restore = stubInvoke(invoke)
    try {
      renderWorkbench()
      await waitConnected()
      clickDb(0)
      // 根层:文件夹 a + 裸 key plain 并存。
      const folderA = await waitFor(() =>{  return screen.getByLabelText('文件夹 a') })
      expect(screen.getByTitle('plain')).toBeTruthy()
      // 嵌套:a → b → 两个叶子。
      fireEvent.click(folderA)
      const folderB = await waitFor(() =>{  return screen.getByLabelText('文件夹 a:b') })
      fireEvent.click(folderB)
      await waitFor(() =>{  expect(screen.getByTitle('a:b:c')).toBeTruthy() })
      expect(screen.getByTitle('a:b:d')).toBeTruthy()
    } finally {
      restore()
    }
  })
})
