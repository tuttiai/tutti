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

COPY voices/discord/package.json      voices/discord/
COPY voices/email/package.json        voices/email/
COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/knowledge/package.json    voices/knowledge/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/notion/package.json       voices/notion/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/postgres/package.json     voices/postgres/
COPY voices/rag/package.json          voices/rag/
COPY voices/sandbox/package.json      voices/sandbox/
COPY voices/slack/package.json        voices/slack/
COPY voices/stripe/package.json       voices/stripe/
COPY voices/telegram/package.json     voices/telegram/
COPY voices/twitter/package.json      voices/twitter/
COPY voices/web/package.json          voices/web/
COPY voices/whatsapp/package.json     voices/whatsapp/

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

# Every voice start.ts can load from TUTTI_VOICES (src/voice-registry.ts),
# which is every voice in voices/. A voice missing here is refused at start as
# "not installed in this image", and the registry test fails first.
COPY voices/discord/src/               voices/discord/src/
COPY voices/discord/tsconfig.json      voices/discord/
COPY voices/discord/tsup.config.ts     voices/discord/

COPY voices/email/src/                 voices/email/src/
COPY voices/email/tsconfig.json        voices/email/
COPY voices/email/tsup.config.ts       voices/email/

COPY voices/filesystem/src/            voices/filesystem/src/
COPY voices/filesystem/tsconfig.json   voices/filesystem/
COPY voices/filesystem/tsup.config.ts  voices/filesystem/

COPY voices/github/src/                voices/github/src/
COPY voices/github/tsconfig.json       voices/github/
COPY voices/github/tsup.config.ts      voices/github/

COPY voices/knowledge/src/             voices/knowledge/src/
COPY voices/knowledge/tsconfig.json    voices/knowledge/
COPY voices/knowledge/tsup.config.ts   voices/knowledge/

COPY voices/mcp/src/                   voices/mcp/src/
COPY voices/mcp/tsconfig.json          voices/mcp/
COPY voices/mcp/tsup.config.ts         voices/mcp/

COPY voices/notion/src/                voices/notion/src/
COPY voices/notion/tsconfig.json       voices/notion/
COPY voices/notion/tsup.config.ts      voices/notion/

COPY voices/playwright/src/            voices/playwright/src/
COPY voices/playwright/tsconfig.json   voices/playwright/
COPY voices/playwright/tsup.config.ts  voices/playwright/

COPY voices/postgres/src/              voices/postgres/src/
COPY voices/postgres/tsconfig.json     voices/postgres/
COPY voices/postgres/tsup.config.ts    voices/postgres/

COPY voices/rag/src/                   voices/rag/src/
COPY voices/rag/tsconfig.json          voices/rag/
COPY voices/rag/tsup.config.ts         voices/rag/

COPY voices/sandbox/src/               voices/sandbox/src/
COPY voices/sandbox/tsconfig.json      voices/sandbox/
COPY voices/sandbox/tsup.config.ts     voices/sandbox/

COPY voices/slack/src/                 voices/slack/src/
COPY voices/slack/tsconfig.json        voices/slack/
COPY voices/slack/tsup.config.ts       voices/slack/

COPY voices/stripe/src/                voices/stripe/src/
COPY voices/stripe/tsconfig.json       voices/stripe/
COPY voices/stripe/tsup.config.ts      voices/stripe/

COPY voices/telegram/src/              voices/telegram/src/
COPY voices/telegram/tsconfig.json     voices/telegram/
COPY voices/telegram/tsup.config.ts    voices/telegram/

COPY voices/twitter/src/               voices/twitter/src/
COPY voices/twitter/tsconfig.json      voices/twitter/
COPY voices/twitter/tsup.config.ts     voices/twitter/

COPY voices/web/src/                   voices/web/src/
COPY voices/web/tsconfig.json          voices/web/
COPY voices/web/tsup.config.ts         voices/web/

COPY voices/whatsapp/src/              voices/whatsapp/src/
COPY voices/whatsapp/tsconfig.json     voices/whatsapp/
COPY voices/whatsapp/tsup.config.ts    voices/whatsapp/

# Build in dependency order (turbo resolves the graph). The server's voice
# devDependencies are part of that graph, so every voice builds too.
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

COPY voices/discord/package.json      voices/discord/
COPY voices/email/package.json        voices/email/
COPY voices/filesystem/package.json   voices/filesystem/
COPY voices/github/package.json       voices/github/
COPY voices/knowledge/package.json    voices/knowledge/
COPY voices/mcp/package.json          voices/mcp/
COPY voices/notion/package.json       voices/notion/
COPY voices/playwright/package.json   voices/playwright/
COPY voices/postgres/package.json     voices/postgres/
COPY voices/rag/package.json          voices/rag/
COPY voices/sandbox/package.json      voices/sandbox/
COPY voices/slack/package.json        voices/slack/
COPY voices/stripe/package.json       voices/stripe/
COPY voices/telegram/package.json     voices/telegram/
COPY voices/twitter/package.json      voices/twitter/
COPY voices/web/package.json          voices/web/
COPY voices/whatsapp/package.json     voices/whatsapp/

RUN npm ci --omit=dev --ignore-scripts

# ── Stage 3: runner ─────────────────────────────────────────
FROM node:24-alpine AS runner

# What the heavier voices run on. Chromium for playwright, because the browser
# Playwright downloads is built for glibc and does not start on Alpine; bash
# and python3 for sandbox, which runs code in either. Node, npm and npx for
# sandbox's TypeScript and for mcp's servers come with the base image.
RUN apk add --no-cache chromium ttf-freefont bash python3

RUN addgroup -g 1001 -S tutti && \
    adduser  -u 1001 -S tutti -G tutti

WORKDIR /app

# Everything under /app stays owned by root, so the agent's own process cannot
# rewrite the server or its dependencies: the filesystem and sandbox voices act
# as the user the server runs as, and that user may only read here.

# Production node_modules (includes workspace symlinks pointing into
# packages/*/  which we populate below with package.json + dist/)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./

# Workspace package manifests (needed for ESM module resolution).
# skills is left out: core imports it for types only.
COPY --from=deps /app/packages/types/package.json     packages/types/
COPY --from=deps /app/packages/telemetry/package.json packages/telemetry/
COPY --from=deps /app/packages/core/package.json      packages/core/
COPY --from=deps /app/packages/realtime/package.json  packages/realtime/
COPY --from=deps /app/packages/server/package.json    packages/server/

# Built artefacts
COPY --from=builder /app/packages/types/dist     packages/types/dist
COPY --from=builder /app/packages/telemetry/dist packages/telemetry/dist
COPY --from=builder /app/packages/core/dist      packages/core/dist
COPY --from=builder /app/packages/realtime/dist  packages/realtime/dist
COPY --from=builder /app/packages/server/dist    packages/server/dist

COPY --from=deps    /app/voices/discord/package.json    voices/discord/
COPY --from=builder /app/voices/discord/dist            voices/discord/dist
COPY --from=deps    /app/voices/email/package.json      voices/email/
COPY --from=builder /app/voices/email/dist              voices/email/dist
COPY --from=deps    /app/voices/filesystem/package.json voices/filesystem/
COPY --from=builder /app/voices/filesystem/dist         voices/filesystem/dist
COPY --from=deps    /app/voices/github/package.json     voices/github/
COPY --from=builder /app/voices/github/dist             voices/github/dist
COPY --from=deps    /app/voices/knowledge/package.json  voices/knowledge/
COPY --from=builder /app/voices/knowledge/dist          voices/knowledge/dist
COPY --from=deps    /app/voices/mcp/package.json        voices/mcp/
COPY --from=builder /app/voices/mcp/dist                voices/mcp/dist
COPY --from=deps    /app/voices/notion/package.json     voices/notion/
COPY --from=builder /app/voices/notion/dist             voices/notion/dist
COPY --from=deps    /app/voices/playwright/package.json voices/playwright/
COPY --from=builder /app/voices/playwright/dist         voices/playwright/dist
COPY --from=deps    /app/voices/postgres/package.json   voices/postgres/
COPY --from=builder /app/voices/postgres/dist           voices/postgres/dist
COPY --from=deps    /app/voices/rag/package.json        voices/rag/
COPY --from=builder /app/voices/rag/dist                voices/rag/dist
COPY --from=deps    /app/voices/sandbox/package.json    voices/sandbox/
COPY --from=builder /app/voices/sandbox/dist            voices/sandbox/dist
COPY --from=deps    /app/voices/slack/package.json      voices/slack/
COPY --from=builder /app/voices/slack/dist              voices/slack/dist
COPY --from=deps    /app/voices/stripe/package.json     voices/stripe/
COPY --from=builder /app/voices/stripe/dist             voices/stripe/dist
COPY --from=deps    /app/voices/telegram/package.json   voices/telegram/
COPY --from=builder /app/voices/telegram/dist           voices/telegram/dist
COPY --from=deps    /app/voices/twitter/package.json    voices/twitter/
COPY --from=builder /app/voices/twitter/dist            voices/twitter/dist
COPY --from=deps    /app/voices/web/package.json        voices/web/
COPY --from=builder /app/voices/web/dist                voices/web/dist
COPY --from=deps    /app/voices/whatsapp/package.json   voices/whatsapp/
COPY --from=builder /app/voices/whatsapp/dist           voices/whatsapp/dist

# The agent's working directory: where a relative path from the filesystem
# voice lands, and the only place under its control besides /tmp.
RUN mkdir /work && chown tutti:tutti /work

ENV NODE_ENV=production
ENV TUTTI_CHROMIUM_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Opt-in: the Claude Code CLI, for TUTTI_PROVIDER=claude-code. Empty by
# default, so the stock image carries nothing extra. Pin an exact version:
#   docker build --build-arg CLAUDE_CODE_VERSION=2.1.284 -t tutti-server:claude-code .
# The CLI signs in from CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) at run
# time; no credential is baked in. On Alpine it needs the system ripgrep and
# the C++ runtime rather than its bundled glibc builds.
ARG CLAUDE_CODE_VERSION=""
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      apk add --no-cache libgcc libstdc++ ripgrep && \
      npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && \
      npm cache clean --force; \
    fi
ENV USE_BUILTIN_RIPGREP=0

USER tutti

WORKDIR /work

EXPOSE 3847

# 127.0.0.1, not localhost: Alpine resolves localhost to ::1 first and the
# server binds 0.0.0.0 (IPv4 only), so the check would never connect.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3847/health || exit 1

CMD ["node", "/app/packages/server/dist/start.js"]
