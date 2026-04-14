# ── Stage 1: install + build ─────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — this layer is cached until any
# package.json or the lockfile changes.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

COPY packages/types/package.json      packages/types/
COPY packages/core/package.json       packages/core/
COPY packages/server/package.json     packages/server/
COPY packages/cli/package.json        packages/cli/
COPY packages/tutti-ai/package.json   packages/tutti-ai/

COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/rag/package.json          voices/rag/

RUN npm ci --ignore-scripts

# Copy only the source needed for types → core → server
COPY packages/types/src/           packages/types/src/
COPY packages/types/tsconfig.json  packages/types/
COPY packages/types/tsup.config.ts packages/types/

COPY packages/core/src/            packages/core/src/
COPY packages/core/tsconfig.json   packages/core/
COPY packages/core/tsup.config.ts  packages/core/

COPY packages/server/src/            packages/server/src/
COPY packages/server/tsconfig.json   packages/server/
COPY packages/server/tsup.config.ts  packages/server/

# Build in dependency order (turbo resolves the graph)
RUN npx turbo run build --filter=@tuttiai/server...

# ── Stage 2: production dependencies ────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

COPY packages/types/package.json      packages/types/
COPY packages/core/package.json       packages/core/
COPY packages/server/package.json     packages/server/
COPY packages/cli/package.json        packages/cli/
COPY packages/tutti-ai/package.json   packages/tutti-ai/

COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/rag/package.json          voices/rag/

RUN npm ci --omit=dev --ignore-scripts

# ── Stage 3: runner ─────────────────────────────────────────
FROM node:24-alpine AS runner

RUN addgroup -g 1001 -S tutti && \
    adduser  -u 1001 -S tutti -G tutti

WORKDIR /app

# Production node_modules (includes workspace symlinks pointing into
# packages/*/  which we populate below with package.json + dist/)
COPY --from=deps --chown=tutti:tutti /app/node_modules ./node_modules
COPY --from=deps --chown=tutti:tutti /app/package.json ./

# Workspace package manifests (needed for ESM module resolution)
COPY --from=deps --chown=tutti:tutti /app/packages/types/package.json  packages/types/
COPY --from=deps --chown=tutti:tutti /app/packages/core/package.json   packages/core/
COPY --from=deps --chown=tutti:tutti /app/packages/server/package.json packages/server/

# Built artefacts
COPY --from=builder --chown=tutti:tutti /app/packages/types/dist  packages/types/dist
COPY --from=builder --chown=tutti:tutti /app/packages/core/dist   packages/core/dist
COPY --from=builder --chown=tutti:tutti /app/packages/server/dist packages/server/dist

ENV NODE_ENV=production

USER tutti

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3847/health || exit 1

CMD ["node", "packages/server/dist/start.js"]
