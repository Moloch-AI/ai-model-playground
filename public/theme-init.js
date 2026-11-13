// Applies a saved theme choice before the first paint. Without one, CSS follows
// prefers-color-scheme. Storage can be blocked, so failures are ignored.
try {
  const saved = window.localStorage.getItem('molochai-playground:theme')
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
} catch (_) {}
