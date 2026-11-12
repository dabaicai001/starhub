/**
 * 会话级工具上下文:按会话保存的绑定读取(aload 两个终端页/助手互不覆盖),
 * 以及升级前单槽存量的兜底。
 */
import { describe, expect, it } from 'vitest'
import {
  parseBindings, readToolContextFor, type Config, type ToolContextBinding,
} from '../src/index.ts'

/** 构造一份测试用 Config(Volatile 只需要 get)。 */
function makeConfig(values: {
  legacy?: { sessionId?: string; subcategory?: string; assetId?: string; assetName?: string }
  bindings?: Record<string, string>
} = {}): Config {
  const legacy = values.legacy ?? {}
  return {
    sessionId: { get: () => legacy.sessionId ?? '' },
    subcategory: { get: () => legacy.subcategory ?? '' },
    assetId: { get: () => legacy.assetId ?? '' },
    assetName: { get: () => legacy.assetName ?? '' },
    routePrefix: { get: () => '' },
    assetType: { get: () => '' },
    dbType: { get: () => '' },
    bindings: { get: () => values.bindings ?? {} },
  }
}

/** 一条绑定条目的 JSON 形态。 */
function entry(value: Partial<ToolContextBinding>): string {
  return JSON.stringify({ subcategory: '', assetId: '', assetName: '', routePrefix: '', assetType: '', dbType: '', updatedAt: 0, ...value })
}

describe('parseBindings', () => {
  it('parses every well-formed entry and skips malformed ones', () => {
    const parsed = parseBindings({
      s1: entry({ assetId: 'a1' }),
      s2: '{not json',
      s3: JSON.stringify(['array-is-not-a-binding']),
    })
    expect(Object.keys(parsed)).toEqual(['s1'])
    expect(parsed.s1?.assetId).toBe('a1')
  })

  it('treats an absent value as no bindings', () => {
    expect(parseBindings(undefined)).toEqual({})
  })
})

describe('readToolContextFor', () => {
  it('keeps two sessions on their own asset instead of overwriting one slot', () => {
    const config = makeConfig({
      bindings: {
        'ssh-assistant-1': entry({ subcategory: 'terminal', assetId: 'a1', assetName: 'web-1', routePrefix: '/ssh', assetType: 'ssh' }),
        'ssh-assistant-2': entry({ subcategory: 'database', assetId: 'd1', assetName: 'mysql-1', routePrefix: '/db/mysql', assetType: 'db', dbType: 'mysql' }),
      },
    })
    expect(readToolContextFor(config, 'ssh-assistant-1')).toMatchObject({ assetId: 'a1', assetName: 'web-1', subcategory: 'terminal' })
    expect(readToolContextFor(config, 'ssh-assistant-2')).toMatchObject({ assetId: 'd1', dbType: 'mysql', subcategory: 'database' })
    expect(readToolContextFor(config, 'other-session')).toEqual({ sessionId: '' })
  })

  it('falls back to the pre-upgrade single slot only for its own session', () => {
    const config = makeConfig({ legacy: { sessionId: 'old-session', subcategory: 'terminal', assetId: 'a0', assetName: 'legacy-host' } })
    expect(readToolContextFor(config, 'old-session')).toMatchObject({ assetId: 'a0', assetName: 'legacy-host' })
    expect(readToolContextFor(config, 'another')).toEqual({ sessionId: '' })
  })

  it('prefers the per-session binding over a stale legacy slot', () => {
    const config = makeConfig({
      legacy: { sessionId: 's1', assetId: 'stale' },
      bindings: { s1: entry({ assetId: 'fresh', assetName: 'fresh-host' }) },
    })
    expect(readToolContextFor(config, 's1')).toMatchObject({ assetId: 'fresh', assetName: 'fresh-host' })
  })
})
