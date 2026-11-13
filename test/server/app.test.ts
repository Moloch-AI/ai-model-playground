import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_PARAMS, filterAccount, pickChatParams } from '../../server/app.js'
import { PRODUCTION_CSP } from '../../server/security.js'
import { makeConfig, rawRequest, startPlayground, startUpstream, waitFor } from './helpers.ts'

type Closer = () => Promise<void>
const cleanup: Closer[] = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function setup(
  handler: Parameters<typeof startUpstream>[0],
  overrides: Parameters<typeof makeConfig>[0] = {},
) {
  const upstream = await startUpstream(handler)
  cleanup.push(upstream.close)
  const playground = await startPlayground(makeConfig({ baseUrl: upstream.baseUrl, ...overrides }))
  cleanup.push(playground.close)
  return { upstream, playground }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }) satisfies Parameters<typeof startUpstream>[0]

async function errorType(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { type: string } }
  return body.error.type
}

function postChat(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  })
}

describe('pickChatParams', () => {
  it('keeps only the allowlisted parameters', () => {
    const picked = pickChatParams({
      model: 'm',
      messages: [],
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      tools: [],
      tool_choice: 'auto',
      max_tokens: 10,
      stop: ['x'],
      seed: 1,
      response_format: { type: 'json_object' },
      n: 2,
      user: 'u',
    })
    expect(Object.keys(picked).sort()).toEqual([...CHAT_PARAMS].sort())
  })

  it('does not copy inherited or undefined keys', () => {
    const body = Object.create({ model: 'inherited' }) as Record<string, unknown>
    body.temperature = undefined
    expect(pickChatParams(body)).toEqual({})
  })
})

describe('filterAccount', () => {
  it('drops email, id and credit', () => {
    const filtered = filterAccount({
      id: 1,
      email: 'dev@example.com',
      credit_usd: 5,
      email_verified: true,
      api_base: 'x',
      plan: 'pro',
      tier: 'pro',
      plan_expires_at: null,
      context_limit: 65536,
      default_model: 'm',
      models: [],
    })
    expect(filtered).toEqual({
      plan: 'pro',
      tier: 'pro',
      plan_expires_at: null,
      context_limit: 65536,
      default_model: 'm',
      models: [],
    })
  })
})

describe('proxy', () => {
  it('forwards only allowlisted chat fields, with the server key and no browser credentials', async () => {
    const { upstream, playground } = await setup(json(200, { object: 'chat.completion', choices: [] }), {
      accessToken: 'browser-token-0123456789',
    })
    const res = await postChat(
      playground.url,
      {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0.3,
        max_tokens: 99,
        seed: 7,
        stop: ['\n'],
        response_format: { type: 'json_object' },
        api_key: 'injected',
      },
      { Authorization: 'Bearer browser-token-0123456789', Cookie: 'session=abc' },
    )
    expect(res.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    const sent = upstream.requests[0]
    expect(sent?.url).toBe('/api/v1/chat/completions')
    expect(sent?.headers.authorization).toBe('Bearer test-api-key-123')
    expect(sent?.headers.cookie).toBeUndefined()
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.3,
    })
  })

  it('passes the status, JSON error body and rate-limit headers through unchanged', async () => {
    const error = {
      error: {
        type: 'context_length_exceeded',
        message: 'Too big.',
        estimated_tokens: 70000,
        context_cap: 65536,
        bound_by: 'plan',
        plan: 'pro',
      },
    }
    const { playground } = await setup(
      json(413, error, {
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '41',
        'Retry-After': '3',
        'Set-Cookie': 'upstream=1',
        'X-Internal-Server': 'node-7',
      }),
    )
    const res = await postChat(playground.url, { model: 'm', messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(413)
    expect(res.headers.get('x-ratelimit-limit')).toBe('60')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('41')
    expect(res.headers.get('retry-after')).toBe('3')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-internal-server')).toBeNull()
    expect(await res.json()).toEqual(error)
  })

  it('relays non-JSON error bodies as plain text with the same status', async () => {
    const { playground } = await setup((_req, res) => {
      res.writeHead(524, { 'Content-Type': 'text/html' })
      res.end('<html><script>alert(1)</script>timeout</html>')
    })
    const res = await postChat(playground.url, { model: 'm', messages: [] })
    expect(res.status).toBe(524)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toContain('timeout')
  })

  it('streams SSE through byte for byte, comment lines included, as it arrives', async () => {
    const parts = [
      ': queued · position 2 of 3 · waiting 4s\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n',
      ': ka\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { playground } = await setup(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-RateLimit-Remaining': '58' })
      res.write(parts[0])
      await gate
      for (const part of parts.slice(1)) res.write(part)
      res.end()
    })
    const res = await postChat(playground.url, { model: 'm', messages: [], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('58')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const decoder = new TextDecoder()
    // The first part arrives before the upstream has finished.
    const first = await waitFor(reader.read(), 2000, 'first chunk')
    expect(decoder.decode(first.value)).toBe(parts[0])
    release()
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
    }
    expect(parts[0] + rest).toBe(parts.join(''))
  })

  it('aborts the upstream request when the browser disconnects mid-stream', async () => {
    let upstreamClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve
    })
    const { playground } = await setup((_req, res) => {
      res.on('close', () => upstreamClosed())
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')
      // Never ends on its own.
    })
    const controller = new AbortController()
    const res = await postChat(
      playground.url,
      { model: 'm', messages: [], stream: true },
      {},
      controller.signal,
    )
    const reader = res.body?.getReader()
    await reader?.read()
    controller.abort()
    await waitFor(closed, 3000, 'upstream close')
  })

  it('aborts the upstream request when the browser leaves before the upstream answers', async () => {
    let upstreamClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve
    })
    let received: () => void = () => {}
    const arrived = new Promise<void>((resolve) => {
      received = resolve
    })
    const { playground } = await setup((_req, res) => {
      res.on('close', () => upstreamClosed())
      received()
      // Never answers.
    })
    const controller = new AbortController()
    const pending = postChat(playground.url, { model: 'm', messages: [] }, {}, controller.signal).catch(
      (err: unknown) => err,
    )
    await waitFor(arrived, 3000, 'upstream request')
    controller.abort()
    await pending
    await waitFor(closed, 3000, 'upstream close')
  })

  it('answers 502 playground_upstream_unreachable when the API cannot be reached', async () => {
    const playground = await startPlayground(makeConfig({ baseUrl: 'http://127.0.0.1:9/api/v1' }))
    cleanup.push(playground.close)
    const res = await fetch(`${playground.url}/api/models`)
    expect(res.status).toBe(502)
    expect(await errorType(res)).toBe('playground_upstream_unreachable')
  })

  it('does not follow redirects (the key must not travel elsewhere)', async () => {
    const target = await startUpstream(json(200, { data: [] }))
    cleanup.push(target.close)
    const { playground } = await setup((_req, res) => {
      res.writeHead(302, { Location: `${target.url}/api/v1/models` })
      res.end()
    })
    const res = await fetch(`${playground.url}/api/models`)
    expect(res.status).toBe(502)
    expect(await errorType(res)).toBe('playground_upstream_redirect')
    expect(target.requests).toHaveLength(0)
  })

  it('maps /api/models and /api/account to the API, filtering the account', async () => {
    const { upstream, playground } = await setup((req, res) => {
      if (req.url === '/api/auth/me') {
        json(200, { id: 1, email: 'dev@example.com', plan: 'pro', credit_usd: 3 })(req, res)
      } else {
        json(200, { object: 'list', data: [{ id: 'm', name: 'M', available: true }] })(req, res)
      }
    })
    const models = await fetch(`${playground.url}/api/models`)
    expect(await models.json()).toEqual({ object: 'list', data: [{ id: 'm', name: 'M', available: true }] })
    const account = await fetch(`${playground.url}/api/account`)
    expect(await account.json()).toEqual({ plan: 'pro' })
    expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/v1/models',
      'GET /api/auth/me',
    ])
  })

  it('never logs prompts, replies or keys', async () => {
    const { playground } = await setup(json(200, { choices: [{ message: { content: 'SECRET-REPLY' } }] }))
    await postChat(playground.url, { model: 'm', messages: [{ role: 'user', content: 'SECRET-PROMPT' }] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const log = playground.logs.join('\n')
    expect(log).toContain('POST /api/chat 200')
    expect(log).not.toContain('SECRET')
    expect(log).not.toContain('test-api-key-123')
  })
})

describe('request validation', () => {
  it('rejects bodies over the cap with 413 and does not call the API', async () => {
    const { upstream, playground } = await setup(json(200, {}), { maxBodyBytes: 1024 })
    const res = await postChat(playground.url, {
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    })
    expect(res.status).toBe(413)
    expect(await errorType(res)).toBe('playground_body_too_large')
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejects a body over the cap without Content-Length (chunked)', async () => {
    const { upstream, playground } = await setup(json(200, {}), { maxBodyBytes: 1024 })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(512)))
        controller.close()
      },
    })
    const res = await fetch(`${playground.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
  })

  it('requires application/json, valid JSON and an object', async () => {
    const { upstream, playground } = await setup(json(200, {}))
    const text = await postChat(playground.url, '{}', { 'Content-Type': 'text/plain' })
    expect(text.status).toBe(415)
    const broken = await postChat(playground.url, '{"model":')
    expect(broken.status).toBe(400)
    expect(await errorType(broken)).toBe('playground_invalid_json')
    const array = await postChat(playground.url, '[]')
    expect(array.status).toBe(400)
    expect(upstream.requests).toHaveLength(0)
  })

  it('answers 405 for the wrong method and 404 for unknown API paths', async () => {
    const { playground } = await setup(json(200, {}))
    const wrong = await fetch(`${playground.url}/api/chat`)
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('POST')
    const unknown = await fetch(`${playground.url}/api/v1/chat/completions`)
    expect(unknown.status).toBe(404)
    expect(await errorType(unknown)).toBe('playground_not_found')
  })
})

describe('access token', () => {
  const token = 'correct-horse-battery-staple'

  it('requires the token on /api routes when configured', async () => {
    const { upstream, playground } = await setup(json(200, { data: [] }), { accessToken: token })
    const none = await fetch(`${playground.url}/api/models`)
    expect(none.status).toBe(401)
    expect(await errorType(none)).toBe('playground_auth_required')
    const wrong = await fetch(`${playground.url}/api/models`, { headers: { Authorization: 'Bearer nope' } })
    expect(wrong.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
    const right = await fetch(`${playground.url}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(right.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })

  it('serves the SPA and /healthz without the token (they hold no secrets)', async () => {
    const { playground } = await setup(json(200, {}), { accessToken: token })
    expect((await fetch(`${playground.url}/`)).status).toBe(200)
    expect((await fetch(`${playground.url}/healthz`)).status).toBe(200)
  })

  it('accepts any Host header when a token is set', async () => {
    const { playground } = await setup(json(200, { data: [] }), { accessToken: token })
    const res = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { Host: 'playground.example.com', Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('browser-facing protections', () => {
  it('only answers to loopback Host names when there is no token (DNS rebinding)', async () => {
    const { upstream, playground } = await setup(json(200, { data: [] }))
    const evil = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { Host: 'attacker.example' },
    })
    expect(evil.status).toBe(403)
    expect(JSON.parse(evil.body).error.type).toBe('playground_forbidden_host')
    const page = await rawRequest(playground.url, { path: '/', headers: { Host: 'attacker.example:8787' } })
    expect(page.status).toBe(403)
    for (const host of ['localhost:8787', '127.0.0.1', '[::1]:8787']) {
      const ok = await rawRequest(playground.url, { path: '/api/models', headers: { Host: host } })
      expect(ok.status, host).toBe(200)
    }
    expect(upstream.requests).toHaveLength(3)
  })

  it('keeps the loopback Host check when a container runs without a token (PLAYGROUND_ALLOW_NO_TOKEN)', async () => {
    const { upstream, playground } = await setup(json(200, { data: [] }), {
      host: '0.0.0.0',
      allowNoToken: true,
    })
    for (const host of ['playground.example.com', '192.0.2.20:8787', 'host.docker.internal:8787']) {
      const res = await rawRequest(playground.url, { path: '/api/models', headers: { Host: host } })
      expect(res.status, host).toBe(403)
      expect(JSON.parse(res.body).error.type).toBe('playground_forbidden_host')
    }
    const local = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { Host: '127.0.0.1:8787' },
    })
    expect(local.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })

  it('rejects cross-origin API calls', async () => {
    const { upstream, playground } = await setup(json(200, { data: [] }))
    const host = new URL(playground.url).host
    const cross = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { Origin: 'https://attacker.example' },
    })
    expect(cross.status).toBe(403)
    const site = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(site.status).toBe(403)
    const same = await rawRequest(playground.url, {
      path: '/api/models',
      headers: { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(same.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
  })

  it('rate-limits /api per client address with Retry-After', async () => {
    const { upstream, playground } = await setup(json(200, { data: [] }), { rateLimit: 2 })
    expect((await fetch(`${playground.url}/api/models`)).status).toBe(200)
    expect((await fetch(`${playground.url}/api/models`)).status).toBe(200)
    const limited = await fetch(`${playground.url}/api/models`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await errorType(limited)).toBe('playground_rate_limited')
    expect(upstream.requests).toHaveLength(2)
    // Static files are not counted.
    expect((await fetch(`${playground.url}/`)).status).toBe(200)
  })

  it('uses the last X-Forwarded-For entry only when told to trust the proxy', async () => {
    const { playground } = await setup(json(200, { data: [] }), { rateLimit: 1, trustProxy: true })
    const as = (ip: string) =>
      rawRequest(playground.url, {
        path: '/api/models',
        headers: { 'X-Forwarded-For': `spoofed-by-client, ${ip}` },
      })
    expect((await as('client-a')).status).toBe(200)
    expect((await as('client-b')).status).toBe(200)
    expect((await as('client-a')).status).toBe(429)
  })

  it('sends the strict CSP and security headers on pages and API responses', async () => {
    const { playground } = await setup(json(200, { data: [] }))
    for (const pathname of ['/', '/api/models']) {
      const res = await fetch(`${playground.url}${pathname}`)
      expect(res.headers.get('content-security-policy')).toBe(PRODUCTION_CSP)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(PRODUCTION_CSP).not.toContain('unsafe')
    expect(PRODUCTION_CSP).toContain("connect-src 'self'")
  })
})

describe('static files', () => {
  it('serves index and hashed assets with the right cache headers', async () => {
    const { playground } = await setup(json(200, {}))
    const index = await fetch(`${playground.url}/`)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(index.headers.get('cache-control')).toBe('no-cache')
    const asset = await fetch(`${playground.url}/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${playground.url}/missing.js`)).status).toBe(404)
  })

  it('does not serve files outside the build directory', async () => {
    const { playground } = await setup(json(200, {}))
    for (const p of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
      '/assets/..%5c..%5cx',
    ]) {
      const res = await rawRequest(playground.url, { path: p })
      expect(res.status, p).toBe(404)
    }
  })

  it('explains a missing build', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'playground-empty-'))
    const playground = await startPlayground(makeConfig(), { staticDir: empty })
    cleanup.push(playground.close)
    const res = await fetch(`${playground.url}/`)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('npm run build')
  })
})
