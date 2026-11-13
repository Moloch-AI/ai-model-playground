import { execFile, spawnSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accountUrl,
  ConfigError,
  DEFAULT_BASE_URL,
  healthcheckUrl,
  hostnameFromHostHeader,
  isLoopbackHost,
  loadConfig,
  startupMessage,
} from '../../server/config.js'
import { createRateLimiter } from '../../server/rate-limit.js'
import { close, listen, makeConfig, startPlayground } from './helpers.ts'

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
      allowNoToken: false,
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

  describe('PLAYGROUND_ALLOW_NO_TOKEN (container published on the host loopback only)', () => {
    it('lets the operator bind a non-loopback address without a token', () => {
      for (const value of ['true', 'TRUE', '1', 'yes', ' true ']) {
        const config = loadConfig({ ...KEY, HOST: '0.0.0.0', PLAYGROUND_ALLOW_NO_TOKEN: value })
        expect(config, value).toMatchObject({ host: '0.0.0.0', accessToken: null, allowNoToken: true })
      }
      expect(loadConfig({ ...KEY, HOST: '::', PLAYGROUND_ALLOW_NO_TOKEN: 'true' }).accessToken).toBeNull()
    })

    it('still refuses unless the value clearly says yes', () => {
      for (const value of ['', 'false', '0', 'no', 'off', 'on', 'ture', 'please']) {
        expect(
          () => loadConfig({ ...KEY, HOST: '0.0.0.0', PLAYGROUND_ALLOW_NO_TOKEN: value }),
          value,
        ).toThrow(/Refusing to listen on 0.0.0.0/)
      }
    })

    it('names the opt-out and its condition in the refusal', () => {
      const error = (() => {
        try {
          loadConfig({ ...KEY, HOST: '0.0.0.0' })
        } catch (err) {
          return err
        }
      })()
      expect(error).toBeInstanceOf(ConfigError)
      expect(String(error)).toContain('docker run -p 127.0.0.1:8787:8787')
      expect(String(error)).toContain('PLAYGROUND_ALLOW_NO_TOKEN=true')
    })

    it('does not turn off a token that is set', () => {
      const config = loadConfig({
        ...KEY,
        HOST: '0.0.0.0',
        PLAYGROUND_ACCESS_TOKEN: 'a'.repeat(24),
        PLAYGROUND_ALLOW_NO_TOKEN: 'true',
      })
      expect(config.accessToken).toBe('a'.repeat(24))
      expect(() =>
        loadConfig({
          ...KEY,
          HOST: '0.0.0.0',
          PLAYGROUND_ACCESS_TOKEN: 'short',
          PLAYGROUND_ALLOW_NO_TOKEN: '1',
        }),
      ).toThrow(/at least 16/)
    })

    it('changes nothing on a loopback address', () => {
      const config = loadConfig({ ...KEY, PLAYGROUND_ALLOW_NO_TOKEN: 'true' })
      expect(config).toMatchObject({ host: '127.0.0.1', accessToken: null })
    })
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

describe('startupMessage', () => {
  const listening = { port: 8787, dev: false }

  it('reports the address and the upstream origin, never the key', () => {
    const lines = startupMessage(loadConfig({ ...KEY, MOLOCHAI_BASE_URL: 'http://127.0.0.1:4010/api/v1' }), {
      port: 4016,
      dev: true,
    })
    expect(lines).toEqual([
      'MolochAI playground listening on http://127.0.0.1:4016 (development)',
      'Forwarding to http://127.0.0.1:4010',
    ])
    expect(lines.join('\n')).not.toContain('your-api-key')
  })

  it('warns that a token-less non-loopback bind must stay on the host loopback', () => {
    const lines = startupMessage(
      loadConfig({ ...KEY, HOST: '0.0.0.0', PLAYGROUND_ALLOW_NO_TOKEN: 'true' }),
      listening,
    )
    expect(lines[0]).toBe('MolochAI playground listening on http://0.0.0.0:8787')
    expect(lines.at(-1)).toMatch(/^No access token \(PLAYGROUND_ALLOW_NO_TOKEN is set\)/)
    expect(lines.at(-1)).toContain('-p 127.0.0.1:8787:8787')
  })

  it('points to HTTPS when a token protects a non-loopback bind', () => {
    const lines = startupMessage(
      loadConfig({ ...KEY, HOST: '::', PLAYGROUND_ACCESS_TOKEN: 'a'.repeat(24) }),
      listening,
    )
    expect(lines).toEqual([
      'MolochAI playground listening on http://[::]:8787',
      'Forwarding to https://api.molochai.dev',
      'Access token required (PLAYGROUND_ACCESS_TOKEN).',
      'Reachable from other machines: put HTTPS in front of it (see docs/deployment.md).',
    ])
  })
})

describe('healthcheckUrl', () => {
  it.each([
    ['0.0.0.0', 'http://127.0.0.1:8787/healthz'],
    ['::', 'http://127.0.0.1:8787/healthz'],
    ['[::]', 'http://127.0.0.1:8787/healthz'],
    ['0:0:0:0:0:0:0:0', 'http://127.0.0.1:8787/healthz'],
    ['127.0.0.1', 'http://127.0.0.1:8787/healthz'],
    ['localhost', 'http://localhost:8787/healthz'],
    ['::1', 'http://[::1]:8787/healthz'],
    ['192.0.2.10', 'http://192.0.2.10:8787/healthz'],
  ])('host %s is checked at %s', (host, url) => {
    expect(healthcheckUrl({ host, port: 8787 })).toBe(url)
  })

  it('cannot check a random port', () => {
    expect(() => healthcheckUrl({ host: '0.0.0.0', port: 0 })).toThrow(ConfigError)
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

describe('server/healthcheck.js', () => {
  const script = fileURLToPath(new URL('../../server/healthcheck.js', import.meta.url))
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.()
  })

  /** Runs the health check as the container would, against 127.0.0.1:<port>. */
  function runHealthcheck(port: string) {
    return new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [script],
        {
          env: {
            ...process.env,
            MOLOCHAI_API_KEY: 'mock-key',
            HOST: '127.0.0.1',
            PORT: port,
            PLAYGROUND_ACCESS_TOKEN: '',
          },
          timeout: 10_000,
        },
        (err, _stdout, stderr) => resolve({ code: err ? (err.code as number) : 0, stderr }),
      )
    })
  }

  it('exits 0 when the playground answers /healthz', async () => {
    const playground = await startPlayground(makeConfig())
    cleanup.push(playground.close)
    const result = await runHealthcheck(new URL(playground.url).port)
    expect(result).toEqual({ code: 0, stderr: '' })
  })

  it('exits 1 when /healthz does not answer 200', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503)
      res.end()
    })
    const url = await listen(server)
    cleanup.push(() => close(server))
    const result = await runHealthcheck(new URL(url).port)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('answered 503')
  })

  it('exits 1 when nothing listens', async () => {
    const server = http.createServer()
    const port = new URL(await listen(server)).port
    await close(server)
    const result = await runHealthcheck(port)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^healthcheck: /)
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
