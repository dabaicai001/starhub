/**
 * 「停止生成」真链路验收:工具插件 → 桥兼容层 → 真 Rust sidecar → 本地 SSH fixture。
 *
 * 覆盖两个入口共用的取消链:
 *   1. 运行中的命令点停止 → exec 通道真的关掉(fixture 报 closed);
 *   2. 排队中的命令点停止 → 命令根本没下发(fixture 没有 exec 记录);
 *   3. 停止之后用户终端连接仍然可用(下一条命令照常执行)。
 *
 * 用法:npm run verify:ai-cancel(先 npm run sidecar-rust:build)
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import * as plugin from '../vendor/deepseek-harness/packages/starhub/tools/src/index.ts'
import { createBridgePeer } from '../vendor/deepseek-harness/packages/starhub/bridge/src/compat.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'starhub-cancel-'))
const localPython = join(root, 'test-sftp', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = process.env.PYTHON ?? (existsSync(localPython) ? localPython : 'python')
const binary = process.argv[2] ?? join(root, 'sidecar-rust', 'target', 'debug', `starhub-sidecar-rust${process.platform === 'win32' ? '.exe' : ''}`)
const children = []
const ctx = new Context()
let transport
let lines
const deadline = setTimeout(() => {
  for (const child of children) child.kill()
}, 60_000)

try {
  if (!existsSync(binary)) {
    console.error(`找不到 sidecar 二进制: ${binary}\n先跑 npm run sidecar-rust:build`)
    process.exit(2)
  }
  const server = spawn(python, [join(root, 'test-sftp/cancel_server.py')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  children.push(server)
  lines = createInterface({ input: server.stdout })
  const events = []
  const waiters = new Set()
  lines.on('line', line => {
    const event = JSON.parse(line)
    events.push(event)
    for (const waiter of waiters) waiter()
  })
  const waitFor = (predicate) => {
    const current = events.find(predicate)
    if (current) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      const check = () => {
        const event = events.find(predicate)
        if (event) { waiters.delete(check); resolve(event) }
      }
      waiters.add(check)
      server.once('exit', () => reject(new Error('SSH fixture exited before observation')))
    })
  }
  const { port } = await waitFor(event => typeof event.port === 'number')
  const assets = join(dir, 'assets.json')
  writeFileSync(assets, JSON.stringify({
    assets: [{
      id: 'test-ssh', type: 'ssh', name: 'cancel fixture',
      config: { host: '127.0.0.1', port, username: 'test', password: 'test', usePasswordAuth: true },
    }],
  }))
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
    env: {
      ...process.env,
      STARHUB_ASSETS_FILE: assets,
      STARHUB_SECRETS_FILE: '',
      STARHUB_KNOWN_HOSTS_FILE: join(dir, 'known-hosts.json'),
      STARHUB_SETTINGS_FILE: join(dir, 'settings.json'),
      STARHUB_AUDIT_FILE: join(dir, 'audit.json'),
      STARHUB_ALERTS_FILE: join(dir, 'alerts.json'),
      STARHUB_CACHE_DIR: join(dir, 'cache'),
    },
  })
  children.push(child)
  transport = new JsonRpcLineTransport(child.stdout, child.stdin)
  // 终端会话(id 无 dsh: 前缀)遇到未知主机密钥会发交互确认,这里按前端的方式应答。
  transport.onNotification((method, params) => {
    if (method !== 'starhub/domain-event') return
    const event = params.event
    if (typeof event !== 'string' || !event.startsWith('ssh:hostkey-confirm:')) return
    void transport.request('ui.ssh_hostkey_response', {
      id: event.slice('ssh:hostkey-confirm:'.length), allowed: true, persist: false,
    })
  })
  transport.start()
  await transport.request('ping', {})
  const connected = await transport.request('ui.ssh_connect', {
    id: 'terminal',
    assetId: 'test-ssh',
    config: { host: '127.0.0.1', port, username: 'test', auth: { Password: 'test' } },
  })
  assert.equal(connected.connected, true)

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sdk-transport', createBridgePeer(transport))
  await ctx.plugin(plugin)
  const tool = ctx.tools.get('ssh_exec')
  assert.ok(tool, 'ssh_exec 工具已注册')
  const invoke = (command, signal, sessionId) => tool.execute(
    { assetId: 'test-ssh', command },
    { agent: { session: { id: sessionId } }, signal },
  )

  // 1) 运行中的命令:点停止 → 执行通道关闭(不是只有界面停了)
  const first = new AbortController()
  const running = invoke('hold', first.signal, 'main-chat').then(() => null, error => error)
  await waitFor(event => event.event === 'exec' && event.command === 'hold')
  // 2) 排队中的命令:还在等会话锁就点停止 → 命令绝不下发
  const queued = new AbortController()
  const waiting = invoke('must-not-run', queued.signal, 'ssh-assistant').then(() => null, error => error)
  queued.abort()
  assert.match(String(await waiting), /EXEC_ABORTED|AbortError/)
  first.abort()
  assert.match(String(await running), /EXEC_ABORTED|AbortError/)
  await waitFor(event => event.event === 'closed' && event.command === 'hold')
  // 3) 停止只中断那一条执行通道:终端连接仍然可用
  const after = await invoke('probe', new AbortController().signal, 'main-chat')
  assert.match(String(after.text), /still-connected/)
  assert.equal(events.some(event => event.command === 'must-not-run'), false)
  console.log('PASS: running exec closed; queued exec never dispatched; terminal connection still usable')
} finally {
  clearTimeout(deadline)
  await ctx.fiber.dispose()
  transport?.close()
  lines?.close()
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }))
  rmSync(dir, { recursive: true, force: true })
}
