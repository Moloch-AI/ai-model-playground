// @ts-check
// Sliding-window rate limiter keyed by client IP. In memory, per process.

/**
 * @typedef {{ ok: true, remaining: number } | { ok: false, retryAfterSeconds: number }} RateDecision
 */

/**
 * @param {object} options
 * @param {number} options.limit       requests allowed per window (0 turns limiting off)
 * @param {number} [options.windowMs]  window length
 * @param {number} [options.maxKeys]   most clients tracked at once; the oldest is dropped first
 * @param {() => number} [options.now]
 */
export function createRateLimiter({ limit, windowMs = 60_000, maxKeys = 10_000, now = Date.now }) {
  /** @type {Map<string, number[]>} key -> request timestamps, oldest first */
  const hits = new Map()

  /**
   * Record one request for `key` if it fits in the window.
   * @param {string} key
   * @returns {RateDecision}
   */
  function take(key) {
    if (limit <= 0) return { ok: true, remaining: Number.POSITIVE_INFINITY }
    const t = now()
    const cutoff = t - windowMs
    const list = (hits.get(key) ?? []).filter((stamp) => stamp > cutoff)
    if (list.length >= limit) {
      hits.set(key, list)
      const oldest = list[0] ?? t
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) }
    }
    list.push(t)
    // Re-insert so Map order tracks recent use, then evict the least recently used keys.
    hits.delete(key)
    hits.set(key, list)
    while (hits.size > maxKeys) {
      const first = hits.keys().next()
      if (first.done) break
      hits.delete(first.value)
    }
    return { ok: true, remaining: limit - list.length }
  }

  return { take, size: () => hits.size }
}
