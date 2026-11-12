/**
 * 快照缓存:首步等一次有界的 pull,之后每步用缓存、刷新在后台;失败进入冷却,
 * 不再让每个模型步都等满预算。
 */
import { describe, expect, it, vi } from 'vitest'
import { LiveSnapshotCache } from '../src/snapshot-cache.ts'

/** 手动时钟,配合真实定时器做预算判定。 */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
}

describe('LiveSnapshotCache', () => {
  it('pulls once and serves the cached snapshot on later steps', async () => {
    const time = clock()
    const cache = new LiveSnapshotCache({ timeoutMs: 50, ttlMs: 1_000, cooldownMs: 1_000 }, time.now)
    const pull = vi.fn(() => Promise.resolve({ recentExecs: ['a'] }))
    expect(await cache.get(pull)).toEqual({ recentExecs: ['a'] })
    time.advance(100)
    expect(await cache.get(pull)).toEqual({ recentExecs: ['a'] })
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('returns the stale snapshot immediately and refreshes in the background', async () => {
    const time = clock()
    const cache = new LiveSnapshotCache({ timeoutMs: 50, ttlMs: 10, cooldownMs: 1_000 }, time.now)
    let release: (value: unknown) => void = () => {}
    const pull = vi.fn(() => Promise.resolve({ step: 1 }))
    expect(await cache.get(pull)).toEqual({ step: 1 })

    // 超龄:这次拿旧值,同时后台发起刷新(不会等它)。
    time.advance(20)
    pull.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    expect(await cache.get(pull)).toEqual({ step: 1 })
    expect(pull).toHaveBeenCalledTimes(2)
    release({ step: 2 })
    // 等后台刷新的微任务链落定(链上有 .then + Promise.race)。
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await cache.get(pull)).toEqual({ step: 2 })
  })

  it('stops pulling during the failure cooldown, then retries', async () => {
    const time = clock()
    const cache = new LiveSnapshotCache({ timeoutMs: 50, ttlMs: 10, cooldownMs: 100 }, time.now)
    const pull = vi.fn(() => Promise.reject(new Error('sidecar gone')))
    expect(await cache.get(pull)).toBeUndefined()
    expect(await cache.get(pull)).toBeUndefined()
    expect(pull).toHaveBeenCalledTimes(1)
    time.advance(100)
    const ok = vi.fn(() => Promise.resolve({ recentExecs: [] }))
    expect(await cache.get(ok)).toEqual({ recentExecs: [] })
  })

  it('gives up after the budget when a pull never settles', async () => {
    const time = clock()
    const cache = new LiveSnapshotCache({ timeoutMs: 20, ttlMs: 10, cooldownMs: 100 }, time.now)
    const started = Date.now()
    const value = await cache.get(() => new Promise<unknown>(() => {}))
    expect(value).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('ignores a non-object answer without poisoning later pulls', async () => {
    const time = clock()
    const cache = new LiveSnapshotCache({ timeoutMs: 50, ttlMs: 10, cooldownMs: 5 }, time.now)
    expect(await cache.get(() => Promise.resolve('not-a-snapshot'))).toBeUndefined()
    time.advance(10)
    expect(await cache.get(() => Promise.resolve({ recentExecs: [] }))).toEqual({ recentExecs: [] })
  })
})
