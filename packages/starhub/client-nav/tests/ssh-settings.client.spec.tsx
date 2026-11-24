// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DEFAULT_TERMINAL_FONT, TERMINAL_ENCODINGS, TERMINAL_FONTS, normalizeTerminalSettings,
  loadTerminalSettings, saveTerminalSettings, terminalOptions, isTerminalFontPreset,
} from '../src/client/terminal/terminal-settings.ts'
import { TerminalSettingsMenu } from '../src/client/terminal/TerminalSettingsMenu.tsx'

afterEach(() => {
  cleanup()
  localStorage.removeItem('starhub.terminal.settings')
})

describe('terminal settings module', () => {
  it('applies defaults when storage is empty', () => {
    const s = loadTerminalSettings()
    expect(s.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
    expect(s.fontSize).toBe(13)
    expect(s.encoding).toBe('utf-8')
    expect(s.cursorBlink).toBe(true)
    expect(s.scrollback).toBe(5000)
  })

  it('normalizes missing/illegal fields back to defaults', () => {
    const s = normalizeTerminalSettings({ fontFamily: '', fontSize: 999, encoding: 'latin1' as never, cursorBlink: 'yes' as never })
    expect(s.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
    expect(s.fontSize).toBe(64) // clamped to the legal range
    expect(s.encoding).toBe('utf-8')
    expect(s.cursorBlink).toBe(true)
  })

  it('clamps fontSize to the legal xterm range', () => {
    expect(normalizeTerminalSettings({ fontSize: 2 }).fontSize).toBe(6)
    expect(normalizeTerminalSettings({ fontSize: 128 }).fontSize).toBe(64)
  })

  it('clamps scrollback to the legal buffer range', () => {
    expect(normalizeTerminalSettings({ scrollback: 10 }).scrollback).toBe(200)
    expect(normalizeTerminalSettings({ scrollback: 999999 }).scrollback).toBe(100000)
    expect(normalizeTerminalSettings({ scrollback: Number.NaN }).scrollback).toBe(5000)
  })

  it('round-trips a saved settings object', () => {
    saveTerminalSettings({ fontFamily: 'Fira Code', fontSize: 15, encoding: 'gbk', cursorBlink: false, scrollback: 2000 })
    const s = loadTerminalSettings()
    expect(s.fontFamily).toBe('Fira Code')
    expect(s.fontSize).toBe(15)
    expect(s.encoding).toBe('gbk')
    expect(s.cursorBlink).toBe(false)
    expect(s.scrollback).toBe(2000)
  })

  it('exposes every supported encoding, font presets, and builds terminal options', () => {
    expect(TERMINAL_ENCODINGS).toContain('utf-8')
    expect(TERMINAL_ENCODINGS).toContain('gbk')
    expect(TERMINAL_FONTS.length).toBeGreaterThan(1)
    expect(TERMINAL_FONTS.some(option => option.value === DEFAULT_TERMINAL_FONT)).toBe(true)
    expect(isTerminalFontPreset(DEFAULT_TERMINAL_FONT)).toBe(true)
    expect(isTerminalFontPreset('Some Custom Mono')).toBe(false)
    const opts = terminalOptions({ fontFamily: 'Mono', fontSize: 14, encoding: 'utf-8', cursorBlink: false, scrollback: 3000 })
    expect(opts).toEqual({ fontFamily: 'Mono', fontSize: 14, cursorBlink: false, scrollback: 3000 })
  })
})

describe('terminal settings menu', () => {
  it('shows saved preferences and persists changes directly from the terminal', () => {
    saveTerminalSettings({ fontFamily: DEFAULT_TERMINAL_FONT, fontSize: 16, encoding: 'big5', cursorBlink: false, scrollback: 5000 })
    render(<TerminalSettingsMenu settings={loadTerminalSettings()} onClose={() => {}} />)
    expect(screen.getByDisplayValue('16')).toBeTruthy()
    expect((screen.getByRole('combobox', { name: '编码' }) as HTMLSelectElement).value).toBe('big5')
    const size = screen.getByRole('slider', { name: '终端字号' })
    fireEvent.change(size, { target: { value: '18' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '光标闪烁' }))
    expect(loadTerminalSettings()).toMatchObject({ fontSize: 18, encoding: 'big5', cursorBlink: true })
  })
})
