/**
 * Standalone StarHub workbench window entry: mount the WindowShell into #root.
 */
import { mount } from './App.tsx'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import './window-shell.css'

// Each workbench document needs its own symbol definitions for the shared DSH icons.
const SVG_NS = 'http://www.w3.org/2000/svg'
const sprite = document.createElementNS(SVG_NS, 'svg')
sprite.setAttribute('data-dsh-icon-sprite', '')
sprite.setAttribute('aria-hidden', 'true')
sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
const parser = new DOMParser()
for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
  const svg = parser.parseFromString(markup, 'image/svg+xml').documentElement
  const symbol = document.createElementNS(SVG_NS, 'symbol')
  symbol.id = id
  for (const { name, value } of svg.attributes) {
    if (name !== 'xmlns') symbol.setAttribute(name, value)
  }
  for (const node of svg.childNodes) symbol.append(document.importNode(node, true))
  sprite.append(symbol)
}
document.querySelector('svg[data-dsh-icon-sprite]')?.remove()
document.body.prepend(sprite)

mount()
