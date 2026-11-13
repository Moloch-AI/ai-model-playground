# Contributing

Thanks for helping. Bug reports, fixes and small focused features are welcome. For larger changes,
open an issue first so we can agree on the approach.

## Setup

You need Node.js 22.12 or newer (Vitest 5 requires it; the built server alone runs on Node 20.19+).

```bash
npm ci
cp .env.example .env   # then set MOLOCHAI_API_KEY, or use the mock server below
npm run dev            # http://127.0.0.1:8787 with hot reload
```

`npm run dev` starts `server/index.js --dev`: the playground server with Vite in middleware mode,
so the app and the `/api` proxy share one port.

For offline work, run the mock server from
[uncensored-ai-api](https://github.com/Moloch-AI/uncensored-ai-api) next to this repository and
point the playground at it:

```bash
git clone https://github.com/Moloch-AI/uncensored-ai-api.git ../uncensored-ai-api
node ../uncensored-ai-api/mock-server/server.mjs --port 4010
MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1 MOLOCHAI_API_KEY=mock-key npm run dev
```

## Checks

CI runs all of these; please run them before opening a pull request.

```bash
npm run lint          # Biome lint and format check (npm run lint:fix applies fixes)
npm run typecheck     # vue-tsc: app, client tests, server and scripts (JS checked via JSDoc)
npm test              # Vitest
npm run build
npm run test:e2e      # needs dist/ and the mock server (see MOLOCHAI_MOCK_SERVER)
npx playwright install --only-shell chromium
npm run test:browser  # Playwright in headless Chromium, needs dist/ and the mock server
```

CI matrix: lint and typecheck on Node 22; unit tests and build on Node 22 and 24; the end-to-end
smoke test runs the built server on Node 20, 22 and 24 (the SPA is built on 22 first); browser
tests on Node 22. Unit tests do not run on Node 20 because Vitest 5 does not support it. The e2e,
browser and Docker jobs check out `Moloch-AI/uncensored-ai-api` at `v0.1.0` for the mock server.

The Docker job builds the image (nothing is pushed), checks that it runs as uid 1000 and holds only
`dist`, `package.json` and `server` in `/app`, checks that it refuses to start on 0.0.0.0 without a
token or `PLAYGROUND_ALLOW_NO_TOKEN`, then starts the mock and three playground containers (no
token on a loopback-only port, the same from an env file made from `.env.example`, and with a
token plus `--read-only --cap-drop ALL`), waits for the image's health check, and runs
`npm run test:e2e` against each with `E2E_PLAYGROUND_URL` (and `E2E_ACCESS_TOKEN`). If you change
the `Dockerfile`, `.dockerignore` or `server/`, build the image and follow
[docs/deployment.md](docs/deployment.md#try-it-against-the-mock-server) locally if you have Docker;
otherwise CI covers it. `.dockerignore` is an allowlist: a new file the build reads must be added
there.

## Layout

```
server/            Node server, plain ESM JavaScript with JSDoc types, no runtime dependencies
  index.js         command-line entry (reads .env, --dev, --quiet)
  healthcheck.js   GET /healthz on this machine, exit 0 or 1 (the Docker HEALTHCHECK)
  app.js           routing, proxying, access token, origin and host checks
  config.js        environment parsing and validation, startup message
  rate-limit.js    per-IP sliding window
  security.js      CSP and other response headers
  static.js        serves dist/
src/               Vue 3 app
  lib/             framework-free logic: SSE parser, stream accumulator, error mapping,
                   <think> splitting, cap notice, request building, code generation
  composables/     useRun: one chat request and its state
  components/      UI pieces
  styles/          design tokens and base styles
test/client/       Vitest: lib modules, theme contrast, App component (happy-dom)
test/server/       Vitest: config, rate limiter, proxy behavior against an in-process fake API
scripts/           e2e-smoke.js (Node built-ins only)
e2e/               Playwright browser tests
docs/              deployment.md (Docker, access token, reverse proxy, rate limit)
Dockerfile         two-stage image: build the SPA, then a runtime without node_modules
.dockerignore      allowlist of the files the image build reads
```

## Guidelines

- Keep the server free of runtime dependencies and keep the production CSP strict: no inline
  scripts or styles, no third-party requests, no `data:` URLs.
- Only build what the API supports. If the API ignores a parameter, the UI does not offer it.
- Error handling decides on HTTP status, error `type` and headers, never on message text.
- Never log or persist prompts, replies, keys or tokens.
- Links to `molochai.dev` and `dash.molochai.dev` carry the campaign parameters
  (`src/lib/links.ts` adds them in the app; add them by hand in Markdown). API URLs are never
  tagged.
- Add or update tests with every behavior change.
- Write plainly and say what is not supported; avoid marketing language.

## Commits and pull requests

Small, focused pull requests are easiest to review. Describe what changed and how you tested it.
Never include API keys, `.env` files or access tokens in issues, commits or pull requests.
