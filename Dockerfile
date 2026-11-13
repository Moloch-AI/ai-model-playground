# MolochAI playground: the built web app plus the small Node server that holds the API key.
#
#   docker build -t ai-model-playground .
#   docker run --rm -p 127.0.0.1:8787:8787 -e MOLOCHAI_API_KEY -e PLAYGROUND_ALLOW_NO_TOKEN=true ai-model-playground
#
# Read docs/deployment.md before making it reachable from any other machine.

# One pinned base for both stages; Dependabot proposes updates. The digest is the multi-platform
# index, so the same line builds on amd64 and arm64.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base

# ---- Build the SPA. Needs the dev dependencies (Vite, the Vue plugin, the fonts); none ship.
FROM base AS build
WORKDIR /src
COPY package.json package-lock.json ./
# No install scripts: on Linux nothing in the lockfile needs one (only fsevents, a macOS package).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- Runtime: Node, the server (Node built-ins only, so no node_modules) and the built SPA.
FROM base AS runtime
# The package managers are not needed to run the server.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# package.json marks server/*.js as ES modules.
COPY package.json ./
COPY server ./server
COPY --from=build /src/dist ./dist

# In a container the server has to listen on every interface to be reachable through a published
# port. It still refuses to start that way without PLAYGROUND_ACCESS_TOKEN, unless
# PLAYGROUND_ALLOW_NO_TOKEN=true says the port is published only on the host's 127.0.0.1.
ENV HOST=0.0.0.0 \
    PORT=8787
EXPOSE 8787

# The base image's "node" user, by number so Kubernetes' runAsNonRoot can verify it. The files
# above stay owned by root, so the server cannot change them.
USER 1000:1000

# GET /healthz answers {"ok":true} without a token and without calling the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "server/healthcheck.js"]

LABEL org.opencontainers.image.title="ai-model-playground" \
      org.opencontainers.image.description="Web playground for the MolochAI API with a Node server that keeps the API key server-side" \
      org.opencontainers.image.source="https://github.com/Moloch-AI/ai-model-playground" \
      org.opencontainers.image.licenses="MIT"

# Extra arguments go to the server, e.g. "docker run ... ai-model-playground --quiet".
ENTRYPOINT ["node", "server/index.js"]
