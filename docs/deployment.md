# Running the playground with Docker

This guide covers building the image, running it for yourself, sharing it with a team behind an
access token and a reverse proxy, and what the built-in protections do and do not do. Read
[What you are exposing](#what-you-are-exposing) first.

No image is published to a registry. You build it from this repository.

- [What you are exposing](#what-you-are-exposing)
- [Build the image](#build-the-image)
- [Run it for yourself (local only)](#run-it-for-yourself-local-only)
- [Use an env file](#use-an-env-file)
- [Share it: the access token](#share-it-the-access-token)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [What the rate limit does](#what-the-rate-limit-does)
- [Public demo (e.g. Hugging Face Spaces)](#public-demo-eg-hugging-face-spaces)
- [Try it against the mock server](#try-it-against-the-mock-server)
- [Operating notes](#operating-notes)

## What you are exposing

The playground server holds your MolochAI API key and sends requests to the API with it. Two
facts decide how careful you need to be.

**The key is not scoped.** It can do everything the API allows for your account, including
reading account details and creating invoices. The playground forwards only three routes (the
model list, chat completions, and a filtered view of your plan and limits), so people using the
playground cannot reach anything else through it. Anyone who gets the key itself can. In a
container the key is in the process environment: anyone with access to the Docker daemon on that
host can read it with `docker inspect` or `docker exec`, and anyone who can read the env file you
started it from has it too.

**Every request spends your quota.** Each prompt sent through the playground counts against your
plan or your credit, no matter who typed it, and is sent under your account, so the
[Acceptable Use Policy](https://molochai.dev/acceptable-use?utm_source=github&utm_medium=oss&utm_campaign=ai-model-playground)
applies to it. A playground that anyone can reach is a public tap on your account.

People who use the playground also see your plan name, its expiry date and your limits (the
`/api/account` route). Your email, account id and credit are not passed on.

The server's defaults follow from this. It listens on 127.0.0.1 only, and it refuses to listen on
any other address unless an access token is set. In a container it has to listen on 0.0.0.0, so
the image makes you choose explicitly.

## Build the image

```bash
git clone https://github.com/Moloch-AI/ai-model-playground.git
cd ai-model-playground
docker build -t ai-model-playground .
```

The build has two stages, both on the same pinned `node:22` Alpine image:

1. `npm ci` (dev dependencies, no install scripts) and `vite build`;
2. a runtime stage with only `package.json`, `server/` and the built `dist/`. The server uses only
   Node built-ins, so there is no `node_modules`; npm, npx, Corepack and Yarn are removed as well.

The container runs as the base image's `node` user (uid 1000), not as root, and the application
files are owned by root, so the server cannot modify them. `.dockerignore` is an allowlist: only
the files the build reads are sent to the builder, so `.env`, `node_modules`, `dist`, test output
and `.git` stay out of the build context.

What the image sets:

| Setting | Value |
|---|---|
| `HOST` | `0.0.0.0` (needed to be reachable through a published port) |
| `PORT` | `8787`, also `EXPOSE`d |
| User | `1000:1000` (`node`) |
| Health check | `node server/healthcheck.js` every 30 s: `GET /healthz` inside the container |
| Entrypoint | `node server/index.js`; arguments after the image name go to the server (`--quiet`) |

## Run it for yourself (local only)

```bash
export MOLOCHAI_API_KEY=your-api-key
docker run --rm -p 127.0.0.1:8787:8787 -e MOLOCHAI_API_KEY -e PLAYGROUND_ALLOW_NO_TOKEN=true ai-model-playground
```

Open http://127.0.0.1:8787.

- `-e MOLOCHAI_API_KEY` with no value copies the variable from your shell, which keeps the key out
  of the command line and your shell history.
- `-p 127.0.0.1:8787:8787` publishes the port on your machine's loopback interface only. This is
  what makes running without a token acceptable. **`-p 8787:8787` publishes it on every interface
  of the host**: anyone on your network, or on the internet if the host has a public address, can
  then use your key. On Linux, ports published by Docker are not filtered by ufw rules (Docker
  writes its own iptables rules), so a host firewall may not save you.
- `PLAYGROUND_ALLOW_NO_TOKEN=true` is the explicit opt-out. Without it (and without a token) the
  server refuses to start:

  ```
  playground: Refusing to listen on 0.0.0.0 without PLAYGROUND_ACCESS_TOKEN. ...
  ```

  The server cannot see how Docker publishes its port, so it takes your word for it and prints a
  reminder when it starts. It accepts `true`, `1` or `yes`; anything else counts as not set. It has
  no effect when `PLAYGROUND_ACCESS_TOKEN` is set. Outside a container, keep `HOST=127.0.0.1`
  instead of using it.
- Without a token the server still answers only requests addressed to `localhost`, `127.0.0.1` or
  `[::1]`, which stops web pages you visit from reaching it through DNS rebinding. That check reads
  the `Host` header, which any program other than a browser can set to anything, so it does not
  replace publishing on 127.0.0.1 only.
- Other containers on the same Docker network can connect to the container directly. Do not attach
  a token-less playground to a network shared with containers you do not trust.

Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>, or `docker stop` when it runs detached.

## Use an env file

```bash
cp .env.example .env
# Edit .env: set MOLOCHAI_API_KEY and uncomment PLAYGROUND_ALLOW_NO_TOKEN=true
chmod 600 .env
docker run --rm -p 127.0.0.1:8787:8787 --env-file .env ai-model-playground
```

Docker reads env files more literally than the server's own `.env` loader:

- No quotes: Docker keeps them as part of the value, so `MOLOCHAI_API_KEY="abc"` sends `"abc"`
  with the quotes and the API answers 401.
- No comments after a value, and no `export`. Lines that start with `#` are comments.
- Leave `HOST` and `PORT` out (they are commented out in `.env.example`). With `HOST=127.0.0.1`
  the server listens on the container's own loopback, where the published port cannot reach it.
- `127.0.0.1` in `MOLOCHAI_BASE_URL` means the container itself, not your machine. See
  [Try it against the mock server](#try-it-against-the-mock-server).

## Share it: the access token

Anything that someone other than you can reach needs `PLAYGROUND_ACCESS_TOKEN`. Generate one (the
image has Node, so you do not need it on the host):

```bash
export PLAYGROUND_ACCESS_TOKEN="$(docker run --rm --entrypoint node ai-model-playground -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))")"
```

and start the container with it (behind a reverse proxy, see the next section):

```bash
docker run -d --name ai-model-playground --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e MOLOCHAI_API_KEY -e PLAYGROUND_ACCESS_TOKEN -e PLAYGROUND_TRUST_PROXY=true \
  ai-model-playground
```

What the token is and is not:

- **One shared secret, not user accounts.** Everyone who has it can spend your quota, and you
  cannot tell users apart or lock out one person. To revoke it, restart with a new token and hand
  that to the people who should keep access.
- The page asks for it once per browser tab and keeps it in session storage, which is cleared when
  the tab closes. It must be at least 16 characters.
- **Over plain HTTP it crosses the network in cleartext** with every request. Put HTTPS in front
  before anyone uses it over a network you do not fully control.
- With a token set, the server answers under any host name (the token is the protection), so a
  reverse proxy can serve it under your domain.

Keep publishing on 127.0.0.1 and let the reverse proxy be the only way in.

## Behind a reverse proxy

The usual setup: the container publishes on the host's 127.0.0.1 (as above), and a reverse proxy
on the same host terminates TLS and forwards to `http://127.0.0.1:8787`. The proxy has to:

- **Pass the original `Host` header.** The server refuses cross-site API calls by comparing the
  browser's `Origin` with `Host`. If the proxy rewrites `Host`, the app's own chat requests are
  refused with 403 `playground_forbidden_origin`. Include the port when the site is not on 443.
- **Append the client address to `X-Forwarded-For`**, together with `PLAYGROUND_TRUST_PROXY=true`
  on the container, so the rate limit counts each client separately. The server uses the *last*
  entry, the one your proxy added. Turn it on only when clients cannot reach the container except
  through the proxy; otherwise anyone can send their own `X-Forwarded-For` and pick the address
  that is counted. With two proxies in a row (for example a CDN and nginx), the last entry is the
  first proxy's address unless your proxy replaces the header with the real client address.
- **Not buffer responses** on `/api/chat`: replies arrive as server-sent events. The server sends
  `X-Accel-Buffering: no`, which nginx honors; for other proxies turn response buffering off.
- **Allow slow responses.** A request with streaming off can take more than a minute before the
  first byte (the MolochAI API's edge gives up after about 100 seconds). nginx's default
  `proxy_read_timeout` of 60 seconds would cut it off first. Streamed replies send a keep-alive
  comment about once a second while waiting, so they are not affected.

A minimal nginx `location` that does this (a sketch, not tested in this repository's CI; TLS
settings omitted):

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 300s;
}
```

## What the rate limit does

- It counts requests to `/api/*` (model list, account, chat) per client address in a sliding
  60-second window: 60 per minute by default, set with `PLAYGROUND_RATE_LIMIT` (`0` turns it off;
  do not do that on a shared instance). The page, its assets and `/healthz` are not counted.
- Over the limit, the server answers 429 with `{"error":{"type":"playground_rate_limited",...}}`
  and `Retry-After`, and the request never reaches the API.
- It lives in memory in one process: restarting the container resets it, and several containers
  do not share it.
- **It limits how often, not how much.** One client within the limit can still use up your quota
  with long requests, and anyone with more addresses gets more requests. It is not a spending cap.
- The address it counts is the one the server sees. Without `PLAYGROUND_TRUST_PROXY`, requests
  that come through a reverse proxy, or that Docker forwards from the host's loopback, can all
  carry the same address, and then everyone shares one limit.
- The API has its own limit of 60 requests per minute per account. Everyone using your playground
  shares it, because they all use your key; past it they see the API's 429 with `Retry-After`.

Separately, chat request bodies are capped at 4 MiB (`PLAYGROUND_MAX_BODY_BYTES`).

## Public demo (e.g. Hugging Face Spaces)

Hosts such as Hugging Face Spaces make it easy to put this container on a public URL. With a real
API key, do not do that today. A public demo means no token, or a token everyone knows, so:

- anyone can spend your quota, and the per-address rate limit does not stop that (it is per
  process, in memory, and more addresses mean more requests);
- everything strangers send goes out with your key and under your account, but the playground has
  no user accounts, no moderation and, by design, no record of prompts, so you could not even see
  what was sent or by whom;
- the key is unscoped: if the host, a collaborator on the hosting account or a mistake in your
  setup exposes the environment, someone has full API access to your account, including account
  details and invoices.

What would have to be true first:

1. A key limited to what the demo needs (chat and the model list), with a spending limit of its
   own, that you can revoke without touching your other keys. MolochAI API keys are not scoped
   today.
2. Sign-in in front of the playground, with limits per user instead of one shared token. The
   playground has neither.
3. Rate limits tied to users and shared by every instance, not per-address counters in one
   process's memory.
4. Moderation and a way to handle abuse reports, as the Acceptable Use Policy expects of anything
   that faces end users.

Until then, keep instances private: local only as above, or behind a token and HTTPS for people you
trust.

## Try it against the mock server

The mock server from [uncensored-ai-api](https://github.com/Moloch-AI/uncensored-ai-api) simulates
the API with canned replies, so you can try the image without a key. These are the steps CI runs:
the mock in one container, the playground in another, on a private Docker network.

```bash
git clone --branch v0.1.0 https://github.com/Moloch-AI/uncensored-ai-api.git .mock/uncensored-ai-api
docker network create playground-net
docker run -d --name mock --network playground-net --no-healthcheck \
  -v "$PWD/.mock/uncensored-ai-api/mock-server:/mock:ro" \
  --entrypoint node ai-model-playground \
  /mock/server.mjs --host 0.0.0.0 --port 4010
docker run --rm --network playground-net -p 127.0.0.1:8787:8787 \
  -e MOLOCHAI_API_KEY=mock-key -e MOLOCHAI_BASE_URL=http://mock:4010/api/v1 \
  -e PLAYGROUND_ALLOW_NO_TOKEN=true \
  ai-model-playground
```

The mock reuses the playground image only because that already has Node; the mock has no
dependencies. `.mock/` is ignored by git and by the Docker build. To run the end-to-end smoke test
against the container from a second terminal (it needs Node on the host):

```bash
E2E_PLAYGROUND_URL=http://127.0.0.1:8787 npm run test:e2e
```

For that, start the mock with `--unavailable llama-3.3-70b-instruct-abliterated` as CI does, and
add `E2E_ACCESS_TOKEN` when the playground has a token. Clean up with
`docker rm -f mock && docker network rm playground-net`.

## Operating notes

- **Health.** `docker ps` shows `healthy` or `unhealthy`; `docker inspect --format
  '{{.State.Health.Status}}' <name>` prints it. `/healthz` answers `{"ok":true}` without a token
  and without contacting the API, so healthy means the server is up, not that your key or the API
  work.
- **Hardening.** The server writes nothing to disk and needs no Linux capabilities, so it runs
  with `--read-only --cap-drop ALL --security-opt no-new-privileges` (CI starts it that way).
- **Logs.** `docker logs <name>` shows one line per request (method, path, status, duration), never
  prompts, replies, tokens or keys. `--quiet` after the image name turns the request log off.
- **Stopping.** `docker stop` sends SIGTERM; the server closes its connections and exits.
- **Updates.** The base image is pinned by version and digest and changes only when this
  repository updates the pin (Dependabot proposes updates weekly). Pull and rebuild to pick up Node
  and Alpine fixes.
