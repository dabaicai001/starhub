import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createBridgePeer } from '../../bridge/src/compat.ts'
import * as plugin from '../src/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('StarHub tool cancellation', () => {
  it('cancels only the owning request and waits for the sidecar to settle', async () => {
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const runtime = await ctx.plugin(ToolRuntime)
    onTestFinished(async () => { await runtime.dispose(); await prompt.dispose() })
    const started = deferred<undefined>()
    const finished = deferred<unknown>()
    const requests: Record<string, unknown>[] = []
    const cancellations: object[] = []
    ctx.provide('sdk-transport', createBridgePeer({
      request: async (_method, params) => {
        requests.push(params as Record<string, unknown>)
        started.resolve(undefined)
        return finished.promise
      },
      notify: (_method, params) => { cancellations.push(params ?? {}) },
    }))
    const fiber = await ctx.plugin(plugin)
    onTestFinished(async () => { await fiber.dispose() })
    const controller = new AbortController()
    // Only the session identity and signal are read by this tool body.
    const exec = { agent: { session: { id: 'assistant-1' } }, signal: controller.signal } as ToolRunContext
    const tool = ctx.tools.get('ssh_exec')!
    const pending = tool.execute({ command: 'tail -f app.log' }, exec)
    const settled = pending.then(() => 'resolved', () => 'rejected')
    await started.promise
    controller.abort()
    expect(cancellations).toEqual([{ execId: requests[0]?._starhubExecId }])
    expect(typeof requests[0]?._starhubExecId).toBe('string')
    let done = false
    void settled.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    finished.reject(new Error('[EXEC_ABORTED] Command aborted by user'))
    expect(await settled).toBe('rejected')
    expect(cancellations).toHaveLength(1)
  })

  it('does not dispatch an already-cancelled call or cancel a completed call', async () => {
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    const runtime = await ctx.plugin(ToolRuntime)
    onTestFinished(async () => { await runtime.dispose(); await prompt.dispose() })
    const requests: object[] = []
    const cancellations: object[] = []
    ctx.provide('sdk-transport', createBridgePeer({
      request: async (_method, params) => { requests.push(params); return { text: 'ok' } },
      notify: (_method, params) => { cancellations.push(params ?? {}) },
    }))
    const fiber = await ctx.plugin(plugin)
    onTestFinished(async () => { await fiber.dispose() })
    const controller = new AbortController()
    const exec = { agent: { session: { id: 'main-chat' } }, signal: controller.signal } as ToolRunContext
    const tool = ctx.tools.get('ssh_exec')!
    await tool.execute({ command: 'pwd' }, exec)
    controller.abort()
    await expect(tool.execute({ command: 'pwd' }, exec)).rejects.toThrow()
    expect(requests).toHaveLength(1)
    expect(cancellations).toHaveLength(0)
  })
})
