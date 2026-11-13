#!/usr/bin/env node
// @ts-check
// Health check for containers: exits 0 when the playground server on this machine answers
// GET /healthz with 200, and 1 otherwise. The Dockerfile's HEALTHCHECK runs it.
//
//   node server/healthcheck.js
//
// It reads HOST and PORT the same way as server/index.js (environment, then .env) and sends no
// credentials: /healthz needs none and answers {"ok":true} without contacting the API.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { healthcheckUrl, loadConfig } from './config.js'

const TIMEOUT_MS = 4000

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  const url = healthcheckUrl(loadConfig(process.env))
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
  await res.body?.cancel()
  if (res.status !== 200) {
    process.stderr.write(`healthcheck: ${url} answered ${res.status}\n`)
    process.exit(1)
  }
} catch (err) {
  // fetch() reports connection problems as "fetch failed" with the reason in `cause`.
  const reason = err instanceof Error && err.cause instanceof Error ? err.cause : err
  process.stderr.write(`healthcheck: ${reason instanceof Error ? reason.message : String(reason)}\n`)
  process.exit(1)
}
