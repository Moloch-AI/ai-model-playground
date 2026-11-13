import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// Browser tests: the production server (serving dist/) in front of the MolochAI mock API.
// Run "npm run build" first. The mock comes from the uncensored-ai-api repository; set
// MOLOCHAI_MOCK_SERVER when it is not checked out next to this repository.
const root = path.dirname(fileURLToPath(import.meta.url))
const mock = path.resolve(
  process.env.MOLOCHAI_MOCK_SERVER ?? path.join(root, '..', 'uncensored-ai-api', 'mock-server', 'server.mjs'),
)
const MOCK_PORT = 4025
const PORT = 4026

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: [
    {
      command: `node "${mock}" --port ${MOCK_PORT} --quiet --unavailable llama-3.3-70b-instruct-abliterated`,
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      command: 'node server/index.js --quiet',
      url: `http://127.0.0.1:${PORT}/healthz`,
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: String(PORT),
        MOLOCHAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
        MOLOCHAI_API_KEY: 'mock-key',
        PLAYGROUND_ACCESS_TOKEN: '',
        PLAYGROUND_RATE_LIMIT: '0',
      },
    },
  ],
})
