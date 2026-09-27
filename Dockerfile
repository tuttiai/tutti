# ── Stage 1: install + build ─────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Copy workspace manifests first — this layer is cached until any
# package.json or the lockfile changes.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

COPY packages/types/package.json      packages/types/
COPY packages/telemetry/package.json  packages/telemetry/
COPY packages/skills/package.json     packages/skills/
COPY packages/core/package.json       packages/core/
COPY packages/realtime/package.json   packages/realtime/
COPY packages/server/package.json     packages/server/
COPY packages/cli/package.json        packages/cli/
COPY packages/tutti-ai/package.json   packages/tutti-ai/

COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/rag/package.json          voices/rag/
COPY voices/email/package.json        voices/email/
COPY voices/slack/package.json        voices/slack/
COPY voices/web/package.json          voices/web/

RUN npm ci --ignore-scripts

# Copy only the source needed to build server and its workspace graph:
# types, telemetry, skills (core imports its types, so the core
# declaration build needs it), core, realtime (a runtime import of
# server), server.
COPY packages/types/src/           packages/types/src/
COPY packages/types/tsconfig.json  packages/types/
COPY packages/types/tsup.config.ts packages/types/

COPY packages/telemetry/src/           packages/telemetry/src/
COPY packages/telemetry/tsconfig.json  packages/telemetry/
COPY packages/telemetry/tsup.config.ts packages/telemetry/

COPY packages/skills/src/           packages/skills/src/
COPY packages/skills/tsconfig.json  packages/skills/
COPY packages/skills/tsup.config.ts packages/skills/

COPY packages/core/src/            packages/core/src/
COPY packages/core/tsconfig.json   packages/core/
COPY packages/core/tsup.config.ts  packages/core/

COPY packages/realtime/src/           packages/realtime/src/
COPY packages/realtime/tsconfig.json  packages/realtime/
COPY packages/realtime/tsup.config.ts packages/realtime/

COPY packages/server/src/            packages/server/src/
COPY packages/server/tsconfig.json   packages/server/
COPY packages/server/tsup.config.ts  packages/server/

# The voices start.ts can load from TUTTI_VOICES (src/voice-registry.ts).
# A voice missing here is refused at start as "not installed in this image".
COPY voices/github/src/            voices/github/src/
COPY voices/github/tsconfig.json   voices/github/
COPY voices/github/tsup.config.ts  voices/github/

COPY voices/slack/src/             voices/slack/src/
COPY voices/slack/tsconfig.json    voices/slack/
COPY voices/slack/tsup.config.ts   voices/slack/

COPY voices/email/src/             voices/email/src/
COPY voices/email/tsconfig.json    voices/email/
COPY voices/email/tsup.config.ts   voices/email/

COPY voices/web/src/               voices/web/src/
COPY voices/web/tsconfig.json      voices/web/
COPY voices/web/tsup.config.ts     voices/web/

# Build in dependency order (turbo resolves the graph). The server's voice
# devDependencies are part of that graph, so the four voices build too.
RUN npx turbo run build --filter=@tuttiai/server...

# ── Stage 2: production dependencies ────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

COPY packages/types/package.json      packages/types/
COPY packages/telemetry/package.json  packages/telemetry/
COPY packages/skills/package.json     packages/skills/
COPY packages/core/package.json       packages/core/
COPY packages/realtime/package.json   packages/realtime/
COPY packages/server/package.json     packages/server/
COPY packages/cli/package.json        packages/cli/
COPY packages/tutti-ai/package.json   packages/tutti-ai/

COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/rag/package.json          voices/rag/
COPY voices/email/package.json        voices/email/
COPY voices/slack/package.json        voices/slack/
COPY voices/web/package.json          voices/web/

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

# Workspace package manifests (needed for ESM module resolution).
# skills is left out: core imports it for types only.
COPY --from=deps --chown=tutti:tutti /app/packages/types/package.json     packages/types/
COPY --from=deps --chown=tutti:tutti /app/packages/telemetry/package.json packages/telemetry/
COPY --from=deps --chown=tutti:tutti /app/packages/core/package.json      packages/core/
COPY --from=deps --chown=tutti:tutti /app/packages/realtime/package.json  packages/realtime/
COPY --from=deps --chown=tutti:tutti /app/packages/server/package.json    packages/server/

# Built artefacts
COPY --from=builder --chown=tutti:tutti /app/packages/types/dist     packages/types/dist
COPY --from=builder --chown=tutti:tutti /app/packages/telemetry/dist packages/telemetry/dist
COPY --from=builder --chown=tutti:tutti /app/packages/core/dist      packages/core/dist
COPY --from=builder --chown=tutti:tutti /app/packages/realtime/dist  packages/realtime/dist
COPY --from=builder --chown=tutti:tutti /app/packages/server/dist    packages/server/dist

COPY --from=deps    --chown=tutti:tutti /app/voices/github/package.json voices/github/
COPY --from=deps    --chown=tutti:tutti /app/voices/slack/package.json  voices/slack/
COPY --from=deps    --chown=tutti:tutti /app/voices/email/package.json  voices/email/
COPY --from=deps    --chown=tutti:tutti /app/voices/web/package.json    voices/web/
COPY --from=builder --chown=tutti:tutti /app/voices/github/dist         voices/github/dist
COPY --from=builder --chown=tutti:tutti /app/voices/slack/dist          voices/slack/dist
COPY --from=builder --chown=tutti:tutti /app/voices/email/dist          voices/email/dist
COPY --from=builder --chown=tutti:tutti /app/voices/web/dist            voices/web/dist

ENV NODE_ENV=production

USER tutti

EXPOSE 3847

# 127.0.0.1, not localhost: Alpine resolves localhost to ::1 first and the
# server binds 0.0.0.0 (IPv4 only), so the check would never connect.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3847/health || exit 1

CMD ["node", "packages/server/dist/start.js"]
