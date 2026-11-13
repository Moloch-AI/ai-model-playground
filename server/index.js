#!/usr/bin/env node
// @ts-check
// Command-line entry for the playground server.
//
//   node server/index.js           serve the built SPA from dist/ (run "npm run build" first)
//   node server/index.js --dev     serve the SPA through Vite with hot reload (development)
//   node server/index.js --quiet   do not log requests
//
// Settings come from the environment, and from a .env file in the project root when present
// (variables already set in the environment win). See .env.example.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPlaygroundServer } from './app.js'
import { ConfigError, isLoopbackHost, loadConfig } from './config.js'

const args = new Set(process.argv.slice(2))
for (const arg of args) {
  if (!['--dev', '--quiet'].includes(arg)) {
    process.stderr.write(`playground: unknown option ${arg} (use --dev and/or --quiet)\n`)
    process.exit(2)
  }
}
const dev = args.has('--dev')
const quiet = args.has('--quiet')

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

let config
try {
  config = loadConfig(process.env)
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`playground: ${err.message}\n`)
    process.exit(1)
  }
  throw err
}

/** @type {import('vite').ViteDevServer | undefined} */
let vite
const server = createPlaygroundServer(config, {
  dev,
  log: quiet ? undefined : (line) => process.stdout.write(`${line}\n`),
  fallback: dev
    ? (req, res) => {
        vite?.middlewares(req, res, () => {
          res.statusCode = 404
          res.end('Not found.\n')
        })
      }
    : undefined,
})

if (dev) {
  // Vite is a dev dependency; production never imports it.
  const { createServer } = await import('vite')
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  })
}

server.on('error', (err) => {
  process.stderr.write(`playground: cannot listen on ${config.host}:${config.port}: ${err.message}\n`)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : config.port
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  const lines = [
    `MolochAI playground listening on http://${host}:${port}${dev ? ' (development)' : ''}`,
    `Forwarding to ${new URL(config.baseUrl).origin}`,
  ]
  if (config.accessToken !== null) lines.push('Access token required (PLAYGROUND_ACCESS_TOKEN).')
  if (!isLoopbackHost(config.host)) {
    lines.push('Reachable from other machines: put HTTPS in front of it (see README, Security).')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
})

let closing = false
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    if (closing) process.exit(1)
    closing = true
    server.closeAllConnections()
    Promise.allSettled([new Promise((resolve) => server.close(resolve)), vite?.close()]).then(() =>
      process.exit(0),
    )
  })
}
