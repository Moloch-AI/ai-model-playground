import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPlaygroundServer, type ServerOptions } from '../../server/app.js'
import type { PlaygroundConfig } from '../../server/config.js'

export interface RecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

export type UpstreamHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void | Promise<void>

/** An in-process stand-in for the API that records what the playground sends it. */
export async function startUpstream(handler: UpstreamHandler) {
  const requests: RecordedRequest[] = []
  const state = { handler }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      void state.handler(req, res, body)
    })
  })
  const url = await listen(server)
  return {
    url,
    baseUrl: `${url}/api/v1`,
    requests,
    setHandler(next: UpstreamHandler) {
      state.handler = next
    },
    close: () => close(server),
  }
}

export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

export function close(server: http.Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

export function makeConfig(overrides: Partial<PlaygroundConfig> = {}): PlaygroundConfig {
  return {
    apiKey: 'test-api-key-123',
    baseUrl: 'http://127.0.0.1:9/api/v1',
    host: '127.0.0.1',
    port: 0,
    accessToken: null,
    rateLimit: 0,
    maxBodyBytes: 64 * 1024,
    trustProxy: false,
    ...overrides,
  }
}

/** A throwaway dist/ with an index page and one hashed asset. */
export function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'playground-dist-'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div>')
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  return dir
}

export async function startPlayground(config: PlaygroundConfig, options: ServerOptions = {}) {
  const lines: string[] = []
  const server = createPlaygroundServer(config, {
    staticDir: makeStaticDir(),
    log: (line) => lines.push(line),
    ...options,
  })
  const url = await listen(server)
  return { url, server, logs: lines, close: () => close(server) }
}

/** Raw request without fetch's URL normalization (for path traversal and Host tests). */
export function rawRequest(
  url: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

export function waitFor<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)),
  ])
}
