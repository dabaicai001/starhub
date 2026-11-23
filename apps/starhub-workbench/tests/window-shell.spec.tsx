// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WindowShell } from '../src/App.tsx'

vi.mock('@deepseek-ai/dsh-starhub-client-nav/src/client/broker/BrokerView.tsx', () => ({
  BrokerView: ({ asset }: { asset: { name: string } }) => <div>{asset.name}</div>,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

it('shows loading, reports a bridge failure and loads the same asset on retry', async () => {
  window.history.replaceState(null, '', '/?asset=a1&embed=1')
  const response = Promise.withResolvers<Response>()
  const fetch = vi.fn()
    .mockRejectedValueOnce(new Error('宿主连接中断'))
    .mockReturnValueOnce(response.promise)
  vi.stubGlobal('fetch', fetch)
  render(<WindowShell />)

  expect(screen.getByRole('status').textContent).toBe('正在加载工作台…')
  expect((await screen.findByRole('alert')).textContent).toContain('宿主连接中断')
  expect(screen.queryByText(/未找到资产/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(screen.getByRole('status').textContent).toBe('正在加载工作台…')
  expect(fetch).toHaveBeenCalledTimes(2)
  response.resolve(Response.json({ ok: true, result: [{ id: 'a1', name: 'Kafka 测试连接', type: 'db', config: { dbType: 'kafka' } }] }))
  expect(await screen.findByText('Kafka 测试连接')).toBeTruthy()
})

it('reports a missing asset when the bridge successfully returns an empty list', async () => {
  window.history.replaceState(null, '', '/?asset=missing')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, result: [] })))
  render(<WindowShell />)
  expect((await screen.findByRole('alert')).textContent).toBe('未找到资产 missing。')
})
