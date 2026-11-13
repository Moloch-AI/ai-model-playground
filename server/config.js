// @ts-check
// Configuration for the playground server, read from the environment.

import { isIP } from 'node:net'

export const DEFAULT_BASE_URL = 'https://api.molochai.dev/api/v1'
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
export const DEFAULT_RATE_LIMIT = 60
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024
export const MIN_ACCESS_TOKEN_LENGTH = 16

/**
 * @typedef {object} PlaygroundConfig
 * @property {string} apiKey          sent upstream as the bearer token; never sent to the browser
 * @property {string} baseUrl         API base URL without a trailing slash
 * @property {string} host            address to bind
 * @property {number} port            port to bind (0 picks a free one)
 * @property {string | null} accessToken  required from browsers when set
 * @property {number} rateLimit       /api requests per minute per client IP (0 turns it off)
 * @property {number} maxBodyBytes    largest accepted request body
 * @property {boolean} trustProxy     take the client IP from the last X-Forwarded-For entry
 */

export class ConfigError extends Error {}

/**
 * True for addresses that only accept connections from this machine.
 * @param {string} host
 */
export function isLoopbackHost(host) {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h === 'localhost') return true
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length)
  const family = isIP(h)
  if (family === 4) return h.startsWith('127.')
  if (family === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1'
  return false
}

/**
 * Hostname part of a Host header value ("localhost:8787", "[::1]:8787", "127.0.0.1").
 * @param {string | undefined} value
 */
export function hostnameFromHostHeader(value) {
  if (!value) return ''
  const v = value.trim().toLowerCase()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    return end === -1 ? v : v.slice(0, end + 1)
  }
  const colon = v.indexOf(':')
  return colon === -1 ? v : v.slice(0, colon)
}

/**
 * @param {string | undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function integer(raw, name, fallback, min, max) {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}, got "${raw}".`)
  }
  return value
}

/**
 * Read and validate the configuration. Throws ConfigError with a message meant for the operator.
 * @param {Record<string, string | undefined>} env
 * @returns {PlaygroundConfig}
 */
export function loadConfig(env) {
  const apiKey = (env.MOLOCHAI_API_KEY ?? '').trim()
  if (!apiKey) {
    throw new ConfigError(
      'MOLOCHAI_API_KEY is not set. Copy .env.example to .env and put your key there ' +
        '(or MOLOCHAI_API_KEY=mock-key when running against the mock server).',
    )
  }

  const rawBase = (env.MOLOCHAI_BASE_URL ?? '').trim() || DEFAULT_BASE_URL
  let base
  try {
    base = new URL(rawBase)
  } catch {
    throw new ConfigError(`MOLOCHAI_BASE_URL is not a valid URL: "${rawBase}".`)
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new ConfigError('MOLOCHAI_BASE_URL must start with https:// or http://.')
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new ConfigError('MOLOCHAI_BASE_URL must not contain credentials, a query or a fragment.')
  }
  const baseUrl = base.href.replace(/\/+$/, '')

  const host = (env.HOST ?? '').trim() || DEFAULT_HOST
  const port = integer(env.PORT, 'PORT', DEFAULT_PORT, 0, 65535)

  const token = env.PLAYGROUND_ACCESS_TOKEN ?? ''
  const accessToken = token.trim() === '' ? null : token
  if (accessToken !== null && accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new ConfigError(
      `PLAYGROUND_ACCESS_TOKEN must be at least ${MIN_ACCESS_TOKEN_LENGTH} characters. ` +
        "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(24).toString('base64url'))\"",
    )
  }
  if (!isLoopbackHost(host) && accessToken === null) {
    throw new ConfigError(
      `Refusing to listen on ${host} without PLAYGROUND_ACCESS_TOKEN. Anyone who can reach this ` +
        'port could spend your API quota through the proxy. Set PLAYGROUND_ACCESS_TOKEN, or keep ' +
        'HOST=127.0.0.1.',
    )
  }

  return {
    apiKey,
    baseUrl,
    host,
    port,
    accessToken,
    rateLimit: integer(env.PLAYGROUND_RATE_LIMIT, 'PLAYGROUND_RATE_LIMIT', DEFAULT_RATE_LIMIT, 0, 100_000),
    maxBodyBytes: integer(
      env.PLAYGROUND_MAX_BODY_BYTES,
      'PLAYGROUND_MAX_BODY_BYTES',
      DEFAULT_MAX_BODY_BYTES,
      1024,
      64 * 1024 * 1024,
    ),
    trustProxy: /^(1|true|yes)$/i.test((env.PLAYGROUND_TRUST_PROXY ?? '').trim()),
  }
}

/**
 * The account endpoint lives outside /v1: https://host/api/v1 -> https://host/api/auth/me.
 * @param {string} baseUrl
 */
export function accountUrl(baseUrl) {
  return /\/v1$/.test(baseUrl) ? baseUrl.replace(/\/v1$/, '/auth/me') : `${baseUrl}/auth/me`
}
