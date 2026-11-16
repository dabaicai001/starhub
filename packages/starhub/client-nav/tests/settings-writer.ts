/**
 * 测试用 settings 写入面:记录 `update` / `mutate` 调用,返回值形状与
 * remote 的 `{ok,result}` 封装一致。类型由 vi.fn 的签名推出,调用方不必再
 * 对 `mock.calls` 做断言转换。
 */
import { vi } from 'vitest'
import type { SettingsPathOp, SettingsUpdateWriter } from '../src/client/tool-context.ts'

/** 一次 mutate 写入解析出的结果。 */
export interface WrittenBinding {
  /** 写入路径里的会话 id。 */
  sessionId: string
  /** 写入的绑定条目(已从 JSON 解析)。 */
  binding: Record<string, unknown>
}

/** 构造一份可断言的 settings 写入面。 */
export function createSettingsWriter() {
  const update = vi.fn((
    _ns: string,
    _patch: Record<string, unknown>,
    _revision: number | undefined,
  ) => Promise.resolve({ ok: true, result: { value: {} } }))
  const mutate = vi.fn((
    _ns: string,
    _ops: readonly SettingsPathOp[],
    _revision: number | undefined,
  ) => Promise.resolve({ ok: true, result: { value: {} } }))
  const writer: SettingsUpdateWriter = { update, mutate }
  return { writer, update, mutate }
}

/** 可断言的 mutate 替身类型。 */
export type MutateSpy = ReturnType<typeof createSettingsWriter>['mutate']

/**
 * 读出最近一次按会话绑定的写入(`bindings[<sessionId>]` 的 JSON)。
 * @param mutate - {@link createSettingsWriter} 返回的 mutate 替身。
 * @returns 路径里的会话 id 与解析后的条目。
 */
export function lastBinding(mutate: MutateSpy): WrittenBinding {
  const call = mutate.mock.calls.at(-1)
  if (call === undefined) throw new Error('mutate 未被调用')
  const op = call[1][0]
  if (op === undefined || op.op !== 'set') throw new Error('期望一次 set 写入')
  return {
    sessionId: op.path[1] ?? '',
    binding: JSON.parse(String(op.value)) as Record<string, unknown>,
  }
}
