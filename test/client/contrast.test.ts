// Checks the theme tokens in src/styles/tokens.css against WCAG 2.x contrast ratios:
// 4.5:1 for text, 3:1 for input borders and the focus ring.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`missing ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const tokens: Record<string, string> = {}
  for (const match of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1] as string] = (match[2] as string).toLowerCase()
  }
  return tokens
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const themes = {
  dark: block(':root[data-theme="dark"]'),
  light: block(':root[data-theme="light"]'),
  'light (system)': block(':root:not([data-theme="dark"])'),
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['fg', 'surface-2'],
  ['fg-2', 'bg'],
  ['fg-2', 'surface'],
  ['fg-2', 'surface-2'],
  ['link', 'bg'],
  ['link', 'surface'],
  ['accent-fg', 'accent'],
  ['accent-fg', 'accent-hover'],
  ['danger', 'surface'],
  ['danger', 'surface-2'],
  ['danger', 'danger-bg'],
  ['fg', 'danger-bg'],
  ['fg-2', 'danger-bg'],
  ['warning', 'warning-bg'],
  ['fg', 'warning-bg'],
  ['info', 'info-bg'],
  ['fg', 'info-bg'],
  ['fg', 'code-bg'],
]

const UI_PAIRS: Array<[string, string]> = [
  ['border-strong', 'surface'],
  ['border-strong', 'surface-2'],
  ['focus', 'bg'],
  ['focus', 'surface'],
]

describe('theme contrast (WCAG AA)', () => {
  it('uses the brand colors', () => {
    expect(themes.dark).toMatchObject({ bg: '#100e12', surface: '#19171c', fg: '#f5f6f8', 'fg-2': '#a5a0ab' })
    expect(themes.dark.accent).toBe('#ff6a3d')
    expect(themes.dark['accent-fg']).toBe('#0b0d11')
    expect(themes.light).toMatchObject({ bg: '#f6f5f2', fg: '#0e1116', 'fg-2': '#47505e', accent: '#c8431a' })
    expect(themes['light (system)']).toEqual(themes.light)
  })

  for (const [name, tokens] of Object.entries(themes)) {
    it.each(TEXT_PAIRS)(`${name}: --%s on --%s is at least 4.5:1`, (fg, bg) => {
      expect(ratio(tokens[fg] as string, tokens[bg] as string)).toBeGreaterThanOrEqual(4.5)
    })
    it.each(UI_PAIRS)(`${name}: --%s against --%s is at least 3:1`, (fg, bg) => {
      expect(ratio(tokens[fg] as string, tokens[bg] as string)).toBeGreaterThanOrEqual(3)
    })
  }
})
