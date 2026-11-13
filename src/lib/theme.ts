// Light and dark theme. Without a saved choice the page follows prefers-color-scheme (CSS does
// that on its own); a saved choice sets data-theme on <html>. public/theme-init.js applies the
// saved choice before the first paint.

import { readStorage, writeStorage } from './storage'

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'molochai-playground:theme'

export function storedTheme(): Theme | null {
  const value = readStorage('local', THEME_KEY)
  return value === 'light' || value === 'dark' ? value : null
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme()
}

export function setTheme(theme: Theme): void {
  writeStorage('local', THEME_KEY, theme)
  document.documentElement.dataset.theme = theme
}
