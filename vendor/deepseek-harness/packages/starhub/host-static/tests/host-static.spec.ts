/**
 * host-static 的 dist 定位优先级(去 Tauri 化 M4 新增 Config 一档)。
 *
 * 顺序是部署形态的决定:provisioning 装好的 dist 走 `windowDist` Config,
 * 开发布局走 `STARHUB_WINDOW_DIST`,最后才是仓库内 `dist-starhub-react`。
 * 三档都可能指向错误的 vite base,因此 env/Config 档必须 fail loud,仓库回退档
 * 只跳过(仓库里可能同时存在多个 dist)。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isImmutableAsset, resolveDist, resolveWindowDistRoot, staticHandler, WINDOW_PREFIX,
} from '../src/index.ts'

/** 造一个带正确 vite base 的假 dist。 */
function makeDist(base = '/starhub-react'): string {
  const dir = mkdtempSync(join(tmpdir(), 'starhub-host-static-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), `<html><script src="${base}/assets/index.js"></script></html>`)
  return dir
}

describe('resolveDist', () => {
  it('prefers the explicit location and rejects a wrong vite base loud', () => {
    const good = makeDist()
    const wrong = makeDist('/starhub')
    expect(resolveDist(WINDOW_PREFIX, good, ['dist-starhub-react'], 'empty')).toBe(good)
    expect(() => resolveDist(WINDOW_PREFIX, wrong, ['dist-starhub-react'], 'empty'))
      .toThrow(/资源引用未带/)
    rmSync(good, { recursive: true, force: true })
    rmSync(wrong, { recursive: true, force: true })
  })

  it('skips a wrong-base repo fallback instead of throwing', () => {
    // 回退档(仓库内)可能同时躺着别的 base 的 dist:跳过而不是炸
    expect(() => resolveDist(WINDOW_PREFIX, undefined, ['/nonexistent-dist'], 'no dist'))
      .toThrow('no dist')
  })
})

describe('resolveWindowDistRoot', () => {
  it('takes the windowDist Config over the env var and the repo fallback', () => {
    const fromConfig = makeDist()
    const fromEnv = makeDist()
    const previous = process.env.STARHUB_WINDOW_DIST
    process.env.STARHUB_WINDOW_DIST = fromEnv
    try {
      expect(resolveWindowDistRoot({ windowDist: fromConfig })).toBe(fromConfig)
      expect(resolveWindowDistRoot({})).toBe(fromEnv)
      expect(resolveWindowDistRoot({ windowDist: '   ' })).toBe(fromEnv)
    } finally {
      if (previous === undefined) delete process.env.STARHUB_WINDOW_DIST
      else process.env.STARHUB_WINDOW_DIST = previous
      rmSync(fromConfig, { recursive: true, force: true })
      rmSync(fromEnv, { recursive: true, force: true })
    }
  })
})

describe('isImmutableAsset', () => {
  it('only treats content-hashed assets as immutable', () => {
    expect(isImmutableAsset('assets/index-BX3k2p1q.js')).toBe(true)
    expect(isImmutableAsset('/assets/index-BX3k2p1q.js')).toBe(true)
    expect(isImmutableAsset('assets/vendor.js')).toBe(false)
    expect(isImmutableAsset('favicon.svg')).toBe(false)
  })
})

describe('staticHandler', () => {
  /** 起一个真实 HTTP server(handler 直接挂在 node:http 上),返回 base URL 与清理函数。 */
  async function startServer(dir: string): Promise<{ base: string; close: () => Promise<void> }> {
    const server = createServer(staticHandler(WINDOW_PREFIX, dir, join(dir, 'index.html')))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return {
      base: `http://127.0.0.1:${port}${WINDOW_PREFIX}`,
      close: () => new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)))
      }),
    }
  }

  it('serves the entry with no-cache and a hashed asset as immutable', async () => {
    const dir = makeDist()
    const asset = join(dir, 'assets', 'index-BX3k2p1q.js')
    writeFileSync(asset, 'console.log(1)')
    const server = await startServer(dir)
    try {
      const index = await fetch(`${server.base}/`)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(index.headers.get('cache-control')).toBe('no-cache')

      const js = await fetch(`${server.base}/assets/index-BX3k2p1q.js`)
      expect(js.status).toBe(200)
      expect(js.headers.get('content-type')).toContain('text/javascript')
      expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await js.text()).toBe('console.log(1)')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers HEAD with headers only', async () => {
    const dir = makeDist()
    writeFileSync(join(dir, 'assets', 'index-BX3k2p1q.js'), 'console.log(1)')
    const server = await startServer(dir)
    try {
      const response = await fetch(`${server.base}/assets/index-BX3k2p1q.js`, { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBe(String('console.log(1)'.length))
      expect(await response.text()).toBe('')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('404s a missing file instead of returning index.html for it', async () => {
    const dir = makeDist()
    const server = await startServer(dir)
    try {
      const missing = await fetch(`${server.base}/assets/index-old00000.js`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe('')

      const spa = await fetch(`${server.base}/workbench/db`)
      expect(spa.status).toBe(200)
      expect(spa.headers.get('content-type')).toContain('text/html')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-GET/HEAD with 405', async () => {
    const dir = makeDist()
    const server = await startServer(dir)
    try {
      const response = await fetch(`${server.base}/`, { method: 'POST' })
      expect(response.status).toBe(405)
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
