// @ts-check
// The playground server: serves the SPA and proxies three API routes, adding the API key.
//
//   GET  /healthz       200 {"ok":true}, no auth (for health checks)
//   GET  /api/models    -> GET  {base}/models
//   GET  /api/account   -> GET  {base minus /v1}/auth/me (filtered to plan and limits)
//   POST /api/chat      -> POST {base}/chat/completions (allowlisted fields only)
//   anything else       the built SPA from dist/ (or Vite in development)
//
// The key never leaves this process: browsers authenticate to the playground (optionally, with
// PLAYGROUND_ACCESS_TOKEN) and the server adds `Authorization: Bearer <MOLOCHAI_API_KEY>` upstream.
// Nothing here logs request bodies, prompts, replies or keys.

import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { accountUrl, hostnameFromHostHeader, isLoopbackHost } from './config.js'
import { createRateLimiter } from './rate-limit.js'
import { securityHeaders } from './security.js'
import { createStaticHandler } from './static.js'

/** The only chat parameters forwarded upstream. Everything else is dropped here. */
export const CHAT_PARAMS = Object.freeze([
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
])

/** Account fields passed to the browser. Email, ids and credit stay on the server. */
export const ACCOUNT_FIELDS = Object.freeze([
  'plan',
  'plan_expires_at',
  'tier',
  'context_limit',
  'default_model',
  'models',
])

const MAX_UPSTREAM_BODY_BYTES = 16 * 1024 * 1024
const USER_AGENT = 'ai-model-playground/0.1.0'

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {(req: Req, res: Res) => void} Fallback
 *
 * @typedef {object} ServerOptions
 * @property {string} [staticDir]  built SPA directory (default: dist/ next to server/)
 * @property {boolean} [dev]       development mode: relaxed CSP for Vite
 * @property {Fallback} [fallback] handles non-API requests instead of the static handler
 * @property {(line: string) => void} [log]
 * @property {() => number} [now]  clock for the rate limiter
 */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} type
   * @param {string} message
   * @param {Record<string, string>} [headers]
   */
  constructor(status, type, message, headers = {}) {
    super(message)
    this.status = status
    this.type = type
    this.headers = headers
  }
}

/**
 * Copy only the allowlisted chat parameters.
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
export function pickChatParams(body) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of CHAT_PARAMS) {
    if (Object.hasOwn(body, key) && body[key] !== undefined) out[key] = body[key]
  }
  return out
}

/**
 * @param {unknown} account
 * @returns {Record<string, unknown>}
 */
export function filterAccount(account) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (!account || typeof account !== 'object') return out
  const source = /** @type {Record<string, unknown>} */ (account)
  for (const key of ACCOUNT_FIELDS) {
    if (Object.hasOwn(source, key)) out[key] = source[key]
  }
  return out
}

/**
 * @param {import('./config.js').PlaygroundConfig} config
 * @param {ServerOptions} [options]
 */
export function createPlaygroundServer(config, options = {}) {
  return http.createServer(createRequestHandler(config, options))
}

/**
 * @param {import('./config.js').PlaygroundConfig} config
 * @param {ServerOptions} [options]
 * @returns {(req: Req, res: Res) => Promise<void>}
 */
export function createRequestHandler(config, options = {}) {
  const staticDir = options.staticDir ?? fileURLToPath(new URL('../dist/', import.meta.url))
  const serveStatic = createStaticHandler(staticDir)
  const headers = securityHeaders({ dev: options.dev === true })
  const limiter = createRateLimiter({ limit: config.rateLimit, now: options.now })
  const expectedToken = config.accessToken === null ? null : sha256(config.accessToken)
  const log = options.log

  return async function handle(req, res) {
    const started = Date.now()
    const pathname = (req.url ?? '/').split('?')[0] || '/'
    if (log) {
      res.once('close', () => {
        const status = res.writableFinished ? String(res.statusCode) : 'aborted'
        log(`${req.method} ${pathname.slice(0, 200)} ${status} ${Date.now() - started}ms`)
      })
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)

    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    try {
      if (pathname === '/healthz') {
        sendJson(res, 200, { ok: true })
        return
      }
      // Without an access token the server only answers to loopback names. This blocks DNS
      // rebinding and reverse proxies that would expose an unauthenticated relay by accident.
      if (expectedToken === null && !isLoopbackHost(hostnameFromHostHeader(req.headers.host))) {
        throw new HttpError(
          403,
          'playground_forbidden_host',
          'This playground has no access token, so it only answers on localhost. Set PLAYGROUND_ACCESS_TOKEN to serve it under another host name.',
        )
      }
      if (!isApi) {
        if (options.fallback) options.fallback(req, res)
        else await serveStatic(req, res, pathname)
        return
      }

      res.setHeader('Cache-Control', 'no-store')
      checkOrigin(req)
      const decision = limiter.take(clientIp(req))
      if (!decision.ok) {
        throw new HttpError(
          429,
          'playground_rate_limited',
          'Too many requests to this playground from your address. Wait and try again.',
          { 'Retry-After': String(decision.retryAfterSeconds) },
        )
      }
      checkToken(req)
      await route(req, res, pathname)
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err, isApi)
      } else {
        log?.(`internal error: ${err instanceof Error ? err.name : 'unknown'}`)
        sendError(
          res,
          new HttpError(500, 'playground_internal_error', 'The playground server failed.'),
          isApi,
        )
      }
    }
  }

  /** @param {Req} req */
  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for']
      const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
      const last = value
        ?.split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1)
      if (last) return last
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** @param {Req} req */
  function checkOrigin(req) {
    const forbidden = () =>
      new HttpError(
        403,
        'playground_forbidden_origin',
        'Cross-site requests to the playground API are not allowed.',
      )
    if (req.headers['sec-fetch-site'] === 'cross-site') throw forbidden()
    const origin = req.headers.origin
    if (origin === undefined) return
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      throw forbidden()
    }
    if (parsed.host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) throw forbidden()
  }

  /** @param {Req} req */
  function checkToken(req) {
    if (expectedToken === null) return
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')
    const given = match?.[1] ? sha256(match[1]) : null
    if (given === null || !timingSafeEqual(given, expectedToken)) {
      throw new HttpError(
        401,
        'playground_auth_required',
        'This playground needs its access token (PLAYGROUND_ACCESS_TOKEN on the server).',
      )
    }
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string} pathname
   */
  async function route(req, res, pathname) {
    switch (pathname) {
      case '/api/models':
        requireMethod(req, 'GET')
        return proxy(res, { method: 'GET', url: `${config.baseUrl}/models` })
      case '/api/account':
        requireMethod(req, 'GET')
        return proxy(res, { method: 'GET', url: accountUrl(config.baseUrl), transform: filterAccount })
      case '/api/chat': {
        requireMethod(req, 'POST')
        const contentType = req.headers['content-type'] ?? ''
        if (!/^application\/json\b/i.test(contentType)) {
          throw new HttpError(
            415,
            'playground_unsupported_media_type',
            'Send the chat request as application/json.',
          )
        }
        const raw = await readBody(req, config.maxBodyBytes)
        let body
        try {
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          throw new HttpError(400, 'playground_invalid_json', 'The request body is not valid JSON.')
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new HttpError(400, 'playground_invalid_body', 'The request body must be a JSON object.')
        }
        return proxy(res, {
          method: 'POST',
          url: `${config.baseUrl}/chat/completions`,
          body: JSON.stringify(pickChatParams(body)),
        })
      }
      default:
        throw new HttpError(404, 'playground_not_found', 'Unknown playground endpoint.')
    }
  }

  /**
   * Forward one request upstream and relay the answer: status, the rate-limit headers and the body
   * (SSE byte for byte, comment lines included). The upstream request is aborted when the
   * browser disconnects.
   * @param {Res} res
   * @param {{ method: 'GET' | 'POST', url: string, body?: string, transform?: (value: unknown) => unknown }} request
   */
  async function proxy(res, { method, url, body, transform }) {
    const controller = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    /** @type {Record<string, string>} */
    const upstreamHeaders = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: method === 'POST' ? 'application/json, text/event-stream' : 'application/json',
      'User-Agent': USER_AGENT,
    }
    if (body !== undefined) upstreamHeaders['Content-Type'] = 'application/json'

    let upstream
    try {
      upstream = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch {
      if (controller.signal.aborted) return
      throw new HttpError(
        502,
        'playground_upstream_unreachable',
        'The playground server could not reach the API. Check MOLOCHAI_BASE_URL and the network, then retry.',
      )
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {})
      throw new HttpError(
        502,
        'playground_upstream_redirect',
        'The API answered with a redirect. Set MOLOCHAI_BASE_URL to the final https:// URL.',
      )
    }

    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase()
      if (lower.startsWith('x-ratelimit-') || lower === 'retry-after') res.setHeader(name, value)
    }
    const contentType = upstream.headers.get('content-type') ?? ''

    if (/^text\/event-stream/i.test(contentType) && upstream.body) {
      res.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders()
      try {
        await pipeline(
          Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (upstream.body)),
          res,
        )
      } catch {
        // The browser left (the upstream request is aborted above) or the upstream connection
        // broke mid-stream. Either way the stream ends here; the status is already sent.
        if (!res.destroyed) res.destroy()
      }
      return
    }

    let text
    try {
      text = await readLimited(upstream, MAX_UPSTREAM_BODY_BYTES)
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof HttpError) throw err
      throw new HttpError(
        502,
        'playground_upstream_unreachable',
        'The connection to the API broke while reading its answer. Retry.',
      )
    }

    if (/\bjson\b/i.test(contentType)) {
      let payload = text
      if (transform && upstream.status === 200) {
        try {
          payload = JSON.stringify(transform(JSON.parse(text)))
        } catch {
          // Not the expected JSON: pass it through unchanged.
        }
      }
      send(res, upstream.status, 'application/json; charset=utf-8', payload)
    } else {
      // Non-JSON bodies (for example an HTML edge-timeout page) are relayed as plain text so the
      // browser never renders upstream HTML under this origin.
      send(res, upstream.status, 'text/plain; charset=utf-8', text)
    }
  }
}

/**
 * @param {Req} req
 * @param {string} method
 */
function requireMethod(req, method) {
  if (req.method !== method) {
    throw new HttpError(405, 'playground_method_not_allowed', `Use ${method} for this endpoint.`, {
      Allow: method,
    })
  }
}

/**
 * Read the request body, refusing anything over `limit` bytes.
 * @param {Req} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  const tooLarge = () =>
    new HttpError(
      413,
      'playground_body_too_large',
      `The request is larger than this playground accepts (${limit} bytes, PLAYGROUND_MAX_BODY_BYTES).`,
      { Connection: 'close' },
    )
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(tooLarge())
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (/** @type {Buffer} */ chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * @param {Response} response
 * @param {number} limit
 */
async function readLimited(response, limit) {
  if (!response.body) return ''
  /** @type {Uint8Array[]} */
  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new HttpError(
        502,
        'playground_upstream_too_large',
        'The API answer was larger than the playground relays.',
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {string} contentType
 * @param {string} body
 */
function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/**
 * @param {Res} res
 * @param {HttpError} err
 * @param {boolean} json
 */
function sendError(res, err, json) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value)
  if (json) sendJson(res, err.status, { error: { type: err.type, message: err.message } })
  else send(res, err.status, 'text/plain; charset=utf-8', `${err.message}\n`)
}
