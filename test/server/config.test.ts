import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  accountUrl,
  ConfigError,
  DEFAULT_BASE_URL,
  hostnameFromHostHeader,
  isLoopbackHost,
  loadConfig,
} from '../../server/config.js'
import { createRateLimiter } from '../../server/rate-limit.js'

const KEY = { MOLOCHAI_API_KEY: 'your-api-key' }

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1'])(
    '%s is loopback',
    (host) => expect(isLoopbackHost(host)).toBe(true),
  )
  it.each(['0.0.0.0', '::', 'example.com', 'localhost.example.com', ''])('%s is not loopback', (host) =>
    expect(isLoopbackHost(host)).toBe(false),
  )
})

describe('hostnameFromHostHeader', () => {
  it('strips the port', () => {
    expect(hostnameFromHostHeader('localhost:8787')).toBe('localhost')
    expect(hostnameFromHostHeader('[::1]:8787')).toBe('[::1]')
    expect(hostnameFromHostHeader('127.0.0.1')).toBe('127.0.0.1')
    expect(hostnameFromHostHeader(undefined)).toBe('')
  })
})

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const config = loadConfig(KEY)
    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      host: '127.0.0.1',
      port: 8787,
      accessToken: null,
      rateLimit: 60,
      trustProxy: false,
    })
  })

  it('requires an API key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({ MOLOCHAI_API_KEY: '  ' })).toThrow(/MOLOCHAI_API_KEY/)
  })

  it('refuses a non-loopback host without an access token', () => {
    expect(() => loadConfig({ ...KEY, HOST: '0.0.0.0' })).toThrow(/Refusing to listen on 0.0.0.0/)
    expect(() => loadConfig({ ...KEY, HOST: '::', PLAYGROUND_ACCESS_TOKEN: '' })).toThrow(ConfigError)
  })

  it('accepts a non-loopback host with a long enough token', () => {
    expect(() => loadConfig({ ...KEY, HOST: '0.0.0.0', PLAYGROUND_ACCESS_TOKEN: 'short' })).toThrow(
      /at least 16/,
    )
    const config = loadConfig({ ...KEY, HOST: '0.0.0.0', PLAYGROUND_ACCESS_TOKEN: 'a'.repeat(24) })
    expect(config.accessToken).toBe('a'.repeat(24))
  })

  it('validates the base URL and strips a trailing slash', () => {
    expect(loadConfig({ ...KEY, MOLOCHAI_BASE_URL: 'http://127.0.0.1:4010/api/v1/' }).baseUrl).toBe(
      'http://127.0.0.1:4010/api/v1',
    )
    expect(() => loadConfig({ ...KEY, MOLOCHAI_BASE_URL: 'not a url' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...KEY, MOLOCHAI_BASE_URL: 'ftp://example.com' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...KEY, MOLOCHAI_BASE_URL: 'https://user:pw@example.com/v1' })).toThrow(
      ConfigError,
    )
  })

  it('validates numbers', () => {
    expect(() => loadConfig({ ...KEY, PORT: 'eighty' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...KEY, PORT: '70000' })).toThrow(/PORT/)
    expect(loadConfig({ ...KEY, PLAYGROUND_RATE_LIMIT: '0' }).rateLimit).toBe(0)
    expect(() => loadConfig({ ...KEY, PLAYGROUND_MAX_BODY_BYTES: '10' })).toThrow(/MAX_BODY/)
    expect(loadConfig({ ...KEY, PLAYGROUND_TRUST_PROXY: 'true' }).trustProxy).toBe(true)
  })
})

describe('accountUrl', () => {
  it('replaces a trailing /v1 with /auth/me', () => {
    expect(accountUrl('https://api.molochai.dev/api/v1')).toBe('https://api.molochai.dev/api/auth/me')
    expect(accountUrl('http://127.0.0.1:4010/api')).toBe('http://127.0.0.1:4010/api/auth/me')
  })
})

describe('server/index.js', () => {
  const entry = fileURLToPath(new URL('../../server/index.js', import.meta.url))

  it('exits with an explanation instead of listening on 0.0.0.0 without a token', () => {
    const result = spawnSync(process.execPath, [entry, '--quiet'], {
      env: {
        ...process.env,
        MOLOCHAI_API_KEY: 'mock-key',
        HOST: '0.0.0.0',
        PORT: '0',
        PLAYGROUND_ACCESS_TOKEN: '',
      },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to listen on 0.0.0.0 without PLAYGROUND_ACCESS_TOKEN')
  })

  it('exits when the API key is missing', () => {
    const result = spawnSync(process.execPath, [entry], {
      env: { ...process.env, MOLOCHAI_API_KEY: '', HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MOLOCHAI_API_KEY is not set')
  })
})

describe('createRateLimiter', () => {
  it('allows `limit` requests per sliding window per key', () => {
    let now = 0
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now })
    expect(limiter.take('a')).toEqual({ ok: true, remaining: 1 })
    now = 400
    expect(limiter.take('a')).toEqual({ ok: true, remaining: 0 })
    now = 500
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 })
    expect(limiter.take('b').ok).toBe(true)
    now = 1001 // the first request left the window
    expect(limiter.take('a').ok).toBe(true)
    expect(limiter.take('a').ok).toBe(false)
  })

  it('is off at limit 0', () => {
    const limiter = createRateLimiter({ limit: 0 })
    for (let i = 0; i < 100; i++) expect(limiter.take('a').ok).toBe(true)
  })

  it('bounds memory by evicting the least recently seen clients', () => {
    const limiter = createRateLimiter({ limit: 5, maxKeys: 3 })
    for (const key of ['a', 'b', 'c', 'd']) limiter.take(key)
    expect(limiter.size()).toBe(3)
  })
})
