// Web Storage access that never throws: storage can be blocked (private windows, strict
// settings, sandboxed previews), and the playground must still work without it.

type Area = 'local' | 'session'

function area(kind: Area): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

export function readStorage(kind: Area, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStorage(kind: Area, key: string, value: string | null): void {
  try {
    const store = area(kind)
    if (!store) return
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    // Storage full or blocked: the setting simply is not remembered.
  }
}
