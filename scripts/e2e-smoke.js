#!/usr/bin/env node
// @ts-check
// End-to-end smoke test: starts the MolochAI mock API and the production playground server
// (serving dist/), then drives both over HTTP the way the browser does.
//
//   npm run build && npm run test:e2e
//
// The mock lives in the uncensored-ai-api repository. By default this script looks for it next
// to this repository (../uncensored-ai-api/mock-server/server.mjs); set MOLOCHAI_MOCK_SERVER to
// its path otherwise. Ports: E2E_MOCK_PORT (default 4015) and E2E_PORT (default 4016).
//
// To test a playground that is already running (CI uses this for the Docker image), set
// E2E_PLAYGROUND_URL to its address; then nothing is started. That playground must forward to the
// mock started with "--unavailable llama-3.3-70b-instruct-abliterated". If it requires an access
// token, put it in E2E_ACCESS_TOKEN.
//
// Uses only Node built-ins, so it also runs on Node 20.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const mockPath = path.resolve(
  process.env.MOLOCHAI_MOCK_SERVER ?? path.join(root, '..', 'uncensored-ai-api', 'mock-server', 'server.mjs'),
)
const mockPort = Number(process.env.E2E_MOCK_PORT ?? 4015)
const port = Number(process.env.E2E_PORT ?? 4016)
const mockUrl = `http://127.0.0.1:${mockPort}`
const external = (process.env.E2E_PLAYGROUND_URL ?? '').trim().replace(/\/+$/, '')
const url = external || `http://127.0.0.1:${port}`
const accessToken = (process.env.E2E_ACCESS_TOKEN ?? '').trim()
/** @type {Record<string, string>} */
const auth = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
const UNAVAILABLE = 'llama-3.3-70b-instruct-abliterated'

/** @type {import('node:child_process').ChildProcess[]} */
const children = []
let passed = 0
let stopping = false

/** @param {string} message */
function fail(message) {
  stopping = true
  console.error(`not ok - ${message}`)
  stopAll()
  process.exit(1)
}

/**
 * @param {unknown} condition
 * @param {string} message
 */
function check(condition, message) {
  if (!condition) fail(message)
  passed++
  console.log(`ok ${passed} - ${message}`)
}

function stopAll() {
  for (const child of children) if (child.exitCode === null) child.kill()
}

/**
 * @param {string} name
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk
  })
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && !stopping) fail(`${name} exited with code ${code}:\n${output}`)
  })
  children.push(child)
  return child
}

/**
 * @param {string} target
 * @param {string} name
 */
async function waitUntilUp(target, name) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  fail(`${name} did not come up at ${target}`)
}

/**
 * GET a playground API route the way the app does (with the access token when there is one).
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 */
function api(pathname, headers = {}) {
  return fetch(`${url}${pathname}`, { headers: { ...auth, ...headers } })
}

/**
 * @param {unknown} body
 */
function chat(body) {
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  })
}

/**
 * GET with an arbitrary Host header, which fetch() does not allow.
 * @param {string} pathname
 * @param {string} host
 * @returns {Promise<{ status: number, body: string }>}
 */
function getWithHost(pathname, host) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: target.hostname, port: target.port, path: pathname, headers: { Host: host } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
  })
}

/** Split an SSE body into data payloads and comment lines. */
function parseSse(/** @type {string} */ text) {
  /** @type {string[]} */
  const data = []
  /** @type {string[]} */
  const comments = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim())
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  return { data, comments }
}

const user = (/** @type {string} */ content) => [{ role: 'user', content }]

/**
 * Parsed JSON body; the checks below look into it field by field.
 * @param {Response} res
 * @returns {Promise<any>}
 */
const readJson = (res) => res.json()

async function main() {
  if (external) {
    console.log(`# testing the running playground at ${url}${accessToken ? ' (with access token)' : ''}`)
  } else {
    if (!existsSync(mockPath)) {
      fail(`mock server not found at ${mockPath} (set MOLOCHAI_MOCK_SERVER)`)
    }
    if (!existsSync(path.join(root, 'dist', 'index.html'))) {
      fail('dist/ is missing: run "npm run build" first')
    }

    start('mock', [mockPath, '--port', String(mockPort), '--quiet', '--unavailable', UNAVAILABLE])
    await waitUntilUp(`${mockUrl}/health`, 'mock API')
    start('playground', ['server/index.js', '--quiet'], {
      HOST: '127.0.0.1',
      PORT: String(port),
      MOLOCHAI_BASE_URL: `${mockUrl}/api/v1`,
      MOLOCHAI_API_KEY: 'mock-key',
      PLAYGROUND_ACCESS_TOKEN: '',
      PLAYGROUND_RATE_LIMIT: '60',
    })
  }
  await waitUntilUp(`${url}/healthz`, 'playground server')

  // The SPA and its security headers
  const page = await fetch(`${url}/`)
  const html = await page.text()
  check(page.status === 200 && html.includes('<div id="app">'), 'GET / serves the built SPA')
  const csp = page.headers.get('content-security-policy') ?? ''
  check(csp.includes("script-src 'self'") && !csp.includes('unsafe'), 'the page has a strict CSP')
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  const asset = script ? await fetch(`${url}${script}`) : null
  check(
    asset?.status === 200 && asset.headers.get('cache-control')?.includes('immutable'),
    'assets are served',
  )

  // Models
  const modelsRes = await api('/api/models')
  const models = /** @type {{ data: Array<{ id: string, name: string, available: boolean }> }} */ (
    await modelsRes.json()
  )
  check(modelsRes.status === 200 && models.data.length === 5, 'GET /api/models lists five models')
  check(
    models.data.every((m) => typeof m.name === 'string' && typeof m.available === 'boolean'),
    'models carry display names and availability',
  )
  check(models.data.find((m) => m.id === UNAVAILABLE)?.available === false, 'unavailable models are marked')
  check(modelsRes.headers.get('x-ratelimit-remaining') !== null, 'X-RateLimit-Remaining is passed through')

  // Account (filtered)
  const account = /** @type {Record<string, unknown>} */ (await (await api('/api/account')).json())
  check(account.plan === 'pro' && Array.isArray(account.models), 'GET /api/account returns plan and models')
  check(
    !('email' in account) && !('credit_usd' in account),
    'the account email and credit stay on the server',
  )

  // Streamed chat
  const streamRes = await chat({
    model: 'glm-5.3-flash',
    messages: user('Hello from the e2e test'),
    stream: true,
    max_tokens: 5,
    seed: 1,
  })
  check(
    streamRes.status === 200 && streamRes.headers.get('content-type')?.startsWith('text/event-stream'),
    'POST /api/chat streams SSE',
  )
  const streamed = parseSse(await streamRes.text())
  check(streamed.comments.includes('ka'), 'SSE comment lines (": ka") reach the browser')
  check(streamed.data.at(-1) === '[DONE]', 'the stream ends with [DONE]')
  const chunks = streamed.data.slice(0, -1).map((d) => JSON.parse(d))
  const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')
  const reasoning = chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? '').join('')
  check(content === 'Mock reply from glm-5.3-flash: Hello from the e2e test', 'streamed content is complete')
  check(reasoning === 'Mock reasoning for glm-5.3-flash.', 'reasoning arrives as reasoning_content deltas')
  const usage = chunks.at(-1)
  check(
    Array.isArray(usage.choices) && usage.choices.length === 0 && usage.usage.total_tokens > 0,
    'the last chunk carries usage with empty choices',
  )

  // Queue comments
  const queued = parseSse(
    await (await chat({ model: 'glm-5.3-flash', messages: user('x [mock:queue]'), stream: true })).text(),
  )
  check(
    queued.comments.some((c) => c.startsWith('queued · position 2 of 3')),
    'queue comments pass through for the UI to show',
  )

  // In-stream error
  const preempted = parseSse(
    await (await chat({ model: 'glm-5.3-flash', messages: user('x [mock:preempted]'), stream: true })).text(),
  )
  const errorEvent = preempted.data.map((d) => (d === '[DONE]' ? null : JSON.parse(d))).find((d) => d?.error)
  check(errorEvent?.error?.type === 'preempted', 'in-stream error events pass through')

  // Non-streamed reply with inline reasoning (split by the UI, passed through by the server)
  const plain = await readJson(
    await chat({ model: 'glm-5.3-flash', messages: user('x [mock:inline-think]') }),
  )
  check(plain.choices[0].message.content.startsWith('<think>'), 'non-streamed replies pass through unchanged')

  // Errors keep their status, body and headers
  const context = await chat({ model: 'glm-5.3-flash', messages: user('x [mock:context]') })
  const contextBody = await readJson(context)
  check(
    context.status === 413 &&
      contextBody.error.context_cap === 65536 &&
      contextBody.error.bound_by === 'plan',
    '413 context_length_exceeded passes through with context_cap and bound_by',
  )
  const limited = await chat({ model: 'glm-5.3-flash', messages: user('x [mock:rate-limit]') })
  check(limited.status === 429 && limited.headers.get('retry-after') === '1', '429 keeps Retry-After')
  const unavailable = await chat({ model: UNAVAILABLE, messages: user('x') })
  check(
    unavailable.status === 503 && (await readJson(unavailable)).error.type === 'model_unavailable',
    '503 model_unavailable passes through',
  )
  const invalid = await chat({ model: 'glm-5.3-flash', messages: user('x'), temperature: 5 })
  check(
    invalid.status === 422 && 'temperature' in (await readJson(invalid)).errors,
    '422 validation errors pass through',
  )
  const edge = await chat({ model: 'glm-5.3-flash', messages: user('x [mock:cloudflare-524]') })
  check(
    edge.status === 524 && edge.headers.get('content-type')?.startsWith('text/plain'),
    'non-JSON 524 bodies are relayed as plain text',
  )

  // Protections
  const crossSite = await api('/api/models', { Origin: 'https://attacker.example' })
  check(crossSite.status === 403, 'cross-origin API calls are refused')
  if (accessToken) {
    const anonymous = await fetch(`${url}/api/models`)
    check(
      anonymous.status === 401 && (await readJson(anonymous)).error.type === 'playground_auth_required',
      'API calls without the access token are refused',
    )
    const wrong = await fetch(`${url}/api/models`, {
      headers: { Authorization: 'Bearer wrong-token-0000000000' },
    })
    check(wrong.status === 401, 'API calls with a wrong access token are refused')
  } else {
    const rebound = await getWithHost('/api/models', 'playground.attacker.example')
    check(
      rebound.status === 403 && JSON.parse(rebound.body).error.type === 'playground_forbidden_host',
      'without a token, requests for another host name are refused (DNS rebinding)',
    )
  }

  console.log(`\n${passed} checks passed`)
  stopping = true
  stopAll()
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)))
