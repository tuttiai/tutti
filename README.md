<div align="center">
  <h1>Tutti</h1>
  <p><strong>All agents. All together.</strong></p>
  <p>Open-source multi-agent orchestration framework for TypeScript.</p>

  <p>
    <a href="https://tutti-ai.com">Website</a> ·
    <a href="https://docs.tutti-ai.com">Docs</a> ·
    <a href="https://github.com/tuttiai/tutti/issues">Issues</a> ·
    <a href="https://discord.gg/tuttiai">Discord</a>
  </p>

  <img src="https://img.shields.io/npm/v/@tuttiai/core?color=0F6E56&label=%40tuttiai%2Fcore" alt="npm" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-0F6E56" alt="Apache 2.0" /></a>
  <img src="https://img.shields.io/github/stars/tuttiai/tutti?color=0F6E56" alt="stars" />
</div>

---

## What is Tutti?

Tutti is a multi-agent orchestration runtime for TypeScript. You compose AI agents from **Voices** (pluggable tool packages), wire them together in a typed **Score** file, and let them work together.

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { FilesystemVoice } from "@tuttiai/filesystem";
import { GitHubVoice } from "@tuttiai/github";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    coder: {
      name: "Coder",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a senior TypeScript developer.",
      voices: [new FilesystemVoice(), new GitHubVoice()],
      permissions: ["filesystem", "network"],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("coder", "Fix the bug in src/index.ts");
console.log(result.output);
```

## Quick Start

```bash
npx tutti-ai init my-project
cd my-project
cp .env.example .env       # add your ANTHROPIC_API_KEY
npm install
npx tutti-ai run
```

## Smart Model Routing

Pick the cheapest model that can handle each turn — automatically. Drop a `SmartProvider` into your score and the router classifies every request and dispatches it to the right tier:

```ts
provider: new SmartProvider({
  tiers: [
    { tier: "small",  provider: new AnthropicProvider(), model: "claude-haiku-4-5-20251001" },
    { tier: "medium", provider: new AnthropicProvider(), model: "claude-sonnet-4-6" },
    { tier: "large",  provider: new AnthropicProvider(), model: "claude-opus-4-7" },
  ],
  classifier: "heuristic",
  policy: "cost-optimised",
}),
```

- Cuts cost by 40–70% on typical agent workloads with zero quality loss on simple tasks.
- Destructive-tool aware — when an agent has `@tuttiai/twitter` or `@tuttiai/stripe` loaded, the router automatically prefers larger, safer models.

See [`packages/router/README.md`](packages/router/README.md) for classifier strategies, policies, fallback chains, and budget-driven downgrades.

## Production Ship

Four pieces shipped in v0.24 that turn Tutti from "great in dev" to "ready in prod":

- **`tutti-ai deploy --target docker|railway|fly`** — bundles your score and ships it. Pre-flight secrets scanning, plan-builder helpers, and `deploy status / logs / rollback` subcommands. Writes a `.env.deploy.example` next to your score so missing env vars block the deploy fail-fast.
- **Tutti Studio** — TypeScript-native visual agent IDE. Web SPA on `localhost:4747` via `tutti-ai studio`. Score graph, live execution stream, replay.
- **Realtime voice** — OpenAI Realtime API integration. Per-agent gating, `SecretsManager` redaction of tool args, `InterruptStore`-gated approval, durable logging. New `@tuttiai/realtime` package and `--realtime` flag on `tutti-ai serve`.
- **Hard cost budgets** — per-run, daily, and monthly USD ceilings throw `BudgetExceededError`. `model: 'auto'` per-agent sentinel for smart routing. Postgres-backed `RunCostStore` for multi-process deployments. `tutti-ai analyze costs` / `report costs` / `budgets` for visibility.

```ts
import { TuttiRuntime, PostgresRunCostStore } from "@tuttiai/core";

const runtime = new TuttiRuntime(score, {
  runCostStore: new PostgresRunCostStore({ connection_string: process.env.DATABASE_URL! }),
});
```

```ts
agents: {
  triage: {
    name: "triage",
    model: "auto",                             // route per turn via SmartProvider
    voices: [],
    budget: {
      max_cost_usd: 0.05,                      // hard per-run cap
      max_cost_usd_per_day: 5.00,              // hard daily cap (requires RunCostStore)
      max_cost_usd_per_month: 50.00,           // hard monthly cap
    },
  },
}
```

```bash
tutti-ai deploy --target railway              # bundle + deploy in one command
tutti-ai analyze costs --last 7d              # top runs, daily sparkline, optimisation hints
tutti-ai studio                                # visual IDE on localhost:4747
tutti-ai serve --realtime                     # WebSocket + audio surface
```

## Packages

Published on npm — run `tutti-ai outdated` in your project for the
versions currently installed, or check the npm page for each package
for the latest published version.

| Package | Description |
| ------- | ----------- |
| [`@tuttiai/types`](packages/types) | Type definitions and Zod schemas (zero runtime deps) |
| [`@tuttiai/core`](packages/core) | Runtime, agent loop, providers, security, memory, telemetry |
| [`@tuttiai/cli`](packages/cli) | CLI — `init`, `run`, `serve`, `studio`, `deploy`, `schedule`, `eval`, `traces`, `memory`, `analyze costs`, and more |
| [`@tuttiai/server`](packages/server) | HTTP server: REST API, SSE streaming, HITL endpoints, cost routes, realtime WebSocket, Docker support |
| [`@tuttiai/router`](packages/router) | Smart model router — classifies turns and dispatches to the cheapest tier that can handle them |
| [`@tuttiai/deploy`](packages/deploy) | Deploy bundlers — Docker / Railway / Fly manifest builders with secrets scanner |
| [`@tuttiai/studio`](packages/studio) | Visual agent IDE — graph view, live execution stream, replay, served by `@tuttiai/server` |
| [`@tuttiai/realtime`](packages/realtime) | OpenAI Realtime API client + tool bridge with `SecretsManager` redaction and `InterruptStore` gating |
| [`@tuttiai/telemetry`](packages/telemetry) | OpenTelemetry tracer — spans for every run, LLM call, and tool invocation |
| [`@tuttiai/filesystem`](voices/filesystem) | 7 file tools (read, write, search, etc.) |
| [`@tuttiai/github`](voices/github) | 10 GitHub tools (issues, PRs, repos, code search) |
| [`@tuttiai/playwright`](voices/playwright) | 12 browser tools (navigate, click, type, screenshot) |
| [`@tuttiai/web`](voices/web) | 3 web tools (search, fetch URL, sitemap) |
| [`@tuttiai/sandbox`](voices/sandbox) | 4 code execution tools (TS, Python, Bash + file I/O) |
| [`@tuttiai/mcp`](voices/mcp) | MCP bridge — wraps any MCP server as a voice |
| [`@tuttiai/rag`](voices/rag) | 4 RAG tools (ingest, search, list sources, delete source) |
| [`@tuttiai/discord`](voices/discord) | 11 Discord tools (messages, channels, members, reactions, DMs) |
| [`@tuttiai/slack`](voices/slack) | 11 Slack tools (channels, threads, DMs, reactions) |
| [`@tuttiai/postgres`](voices/postgres) | 8 Postgres tools (query/execute + schema introspection) |
| [`@tuttiai/stripe`](voices/stripe) | 27 Stripe tools (customers, payments, subs, invoices, balance) |
| [`@tuttiai/twitter`](voices/twitter) | 9 Twitter / X tools (tweets, threads, mentions, timeline) |

## Features

### Multi-Agent Orchestration

An orchestrator agent delegates to specialists via `AgentRouter`:

```ts
import { AgentRouter, defineScore } from "@tuttiai/core";

const score = defineScore({
  provider: new AnthropicProvider(),
  entry: "orchestrator",
  agents: {
    orchestrator: {
      name: "Orchestrator",
      role: "orchestrator",
      system_prompt: "Route tasks to the right specialist.",
      voices: [],
      delegates: ["coder", "qa"],
    },
    coder: { /* ... */ },
    qa: { /* ... */ },
  },
});

const router = new AgentRouter(score);
const result = await router.run("Write and test a reverse function");
```

### Three LLM Providers

```ts
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from "@tuttiai/core";

new AnthropicProvider()          // ANTHROPIC_API_KEY
new OpenAIProvider()             // OPENAI_API_KEY
new GeminiProvider()             // GEMINI_API_KEY
```

### Persistent Sessions (PostgreSQL)

```ts
const score = defineScore({
  provider: new AnthropicProvider(),
  memory: { provider: "postgres" },  // uses DATABASE_URL
  agents: { /* ... */ },
});

const tutti = await TuttiRuntime.create(score);  // async init for DB
```

### Semantic (Long-Term) Memory

Agents remember facts across sessions:

```ts
{
  coder: {
    name: "Coder",
    system_prompt: "You are a TypeScript developer.",
    memory: { semantic: { enabled: true, max_memories: 5 } },
    voices: [new FilesystemVoice()],
    permissions: ["filesystem"],
  },
}
```

Tools can explicitly store memories:

```ts
execute: async (input, context) => {
  await context.memory?.remember("User prefers 2-space indentation");
  const prefs = await context.memory?.recall("code style");
  return { content: "Noted your preferences." };
}
```

### Security

- **Permission system** — voices declare requirements, agents grant explicitly
- **Secret redaction** — API keys scrubbed from events and error messages
- **Prompt injection defense** — tool results scanned and wrapped with safety markers
- **Path traversal protection** — system paths blocked in filesystem voice
- **URL sanitization** — `file:`, `javascript:`, private IPs blocked in browser voice
- **Token budgets** — per-agent limits on tokens and cost
- **Tool rate limiting** — max calls per run + per-tool timeout
- **Score validation** — Zod-validated on load

### Observability

Every step emits typed events:

```ts
tutti.events.on("tool:start", (e) => console.log(`Using: ${e.tool_name}`));
tutti.events.on("budget:warning", (e) => console.log(`Budget: ${e.tokens} tokens`));
tutti.events.on("security:injection_detected", (e) => console.warn(`Injection in: ${e.tool_name}`));
```

### Scheduled Agents

Run agents on a schedule — cron expressions, fixed intervals, or one-shot datetimes:

```ts
const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    reporter: {
      name: "Reporter",
      system_prompt: "Generate a daily status report.",
      voices: [new WebVoice()],
      permissions: ["network"],
      schedule: {
        cron: "0 9 * * *",       // 9 AM daily
        input: "Generate the daily status report",
        max_runs: 30,             // auto-disable after 30 runs
      },
    },
  },
});
```

```bash
tutti-ai schedule              # start the scheduler daemon
tutti-ai schedules list        # show all schedules
tutti-ai schedules trigger id  # run one immediately
```

## CLI

```bash
# Project
tutti-ai init [project]              # Scaffold a new project
tutti-ai templates                   # List available scaffolding templates
tutti-ai check [score]               # Validate a score
tutti-ai doctor [score]              # Diagnose env, deps, and config
tutti-ai info [score]                # Show agents, voices, versions

# Run
tutti-ai run [score]                 # Run a score interactively (REPL)
tutti-ai run -p "ask something"      # One-shot: single prompt, prints to stdout
tutti-ai serve [score]               # Start the HTTP server
tutti-ai serve --realtime            # Start the HTTP server with the realtime WebSocket
tutti-ai studio [score]              # Launch the web UI on localhost:4747
tutti-ai resume <session-id>         # Resume a previous session
tutti-ai replay <session-id>         # Time-travel debug a session

# Deploy
tutti-ai deploy [--target docker|railway|fly] [--dry-run]
                                     # Bundle the score and deploy
tutti-ai deploy status               # Platform-equivalent status check
tutti-ai deploy logs [--tail]        # Stream platform logs
tutti-ai deploy rollback             # Roll back to the previous deploy

# Cost analysis
tutti-ai analyze costs [--last 7d]   # Top runs, daily sparkline, optimisation hints
tutti-ai report costs [--format text|json|csv]
                                     # Exportable cost report
tutti-ai budgets [--agent <id>]      # Per-agent budget config + current spend

# Voices & packages
tutti-ai add <voice>                 # Install a voice
tutti-ai voices                      # List official voices
tutti-ai search <query>              # Search the voice registry
tutti-ai upgrade [voice]             # Upgrade voices to latest
tutti-ai update                      # Update all @tuttiai packages
tutti-ai outdated                    # Check for newer versions
tutti-ai publish                     # Publish a community voice

# Scheduling
tutti-ai schedule [score]            # Start the scheduler daemon
tutti-ai schedules list              # Show all schedules
tutti-ai schedules enable <id>       # Enable a schedule
tutti-ai schedules disable <id>      # Disable a schedule
tutti-ai schedules trigger <id>      # Trigger a run immediately
tutti-ai schedules runs <id>         # List recent runs of a schedule

# Evaluation
tutti-ai eval suite <suite-file>     # Run a golden-suite evaluation
tutti-ai eval record <session-id>    # Record a session as a golden case
tutti-ai eval list                   # List recorded golden cases
tutti-ai eval run                    # Re-run all recorded golden cases

# Tracing
tutti-ai traces list                 # List recent traces
tutti-ai traces show <trace-id>      # Inspect spans for a single run
tutti-ai traces tail                 # Live-tail traces as they happen
tutti-ai traces router <trace-id>    # Show router decisions for a trace

# Long-term memory
tutti-ai memory list                 # List stored memories
tutti-ai memory search <query>       # Search memories semantically
tutti-ai memory add <content>        # Add a memory (with --importance)
tutti-ai memory delete <memory-id>   # Delete a memory
tutti-ai memory clear                # Wipe the memory store
tutti-ai memory export               # Export memories to JSON

# Human-in-the-loop
tutti-ai interrupts list             # List pending tool-call approvals
tutti-ai interrupts approve <id>     # Approve a pending tool call
tutti-ai interrupts deny <id>        # Deny a pending tool call
tutti-ai approve                     # Interactive approval TUI
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   tutti.score.ts                      │
│             (defineScore — typed config)              │
├──────────────────────────────────────────────────────┤
│                   TuttiRuntime                        │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ AgentRunner│  │ EventBus │  │  SessionStore     │ │
│  │  (loop)    │  │ (pub/sub)│  │  (memory/postgres)│ │
│  └─────┬──────┘  └──────────┘  └──────────────────┘ │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │           LLMProvider (swappable)              │  │
│  │  Anthropic  ·  OpenAI  ·  Gemini              │  │
│  └────────────────────────────────────────────────┘  │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │              Voices (plugins)                  │  │
│  │  Filesystem · GitHub · Playwright · yours      │  │
│  └────────────────────────────────────────────────┘  │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │              Security Layer                    │  │
│  │  Permissions · Secrets · PromptGuard · Budget  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Deploy in 60 Seconds

```bash
# 1. Clone and configure
git clone https://github.com/tuttiai/tutti.git && cd tutti
cp .env.example .env
# Edit .env — set TUTTI_API_KEY and your LLM provider key

# 2. Start everything (server + Postgres + Redis)
docker compose up -d

# 3. Verify
curl http://localhost:3847/health
# → {"status":"ok","version":"0.1.0","uptime_s":2}

# 4. Run your first agent call
curl -X POST http://localhost:3847/run \
  -H "Authorization: Bearer <your-tutti-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"input": "What is Tutti?"}'
```

The Docker image runs as non-root user `tutti` (uid 1001). Postgres uses
[pgvector](https://github.com/pgvector/pgvector) for RAG and session storage.
Redis is used for durable execution checkpoints.

See [`.env.example`](.env.example) for all configuration options.
One-click deploy configs for [Railway](scripts/deploy/railway.json) and
[Render](scripts/deploy/render.yaml) are in `scripts/deploy/`.

## Testing

1,800+ tests across 132 files. 96% line coverage on core.

```bash
npx vitest run              # all tests
npm run test:coverage       # with v8 coverage
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [contributing docs](https://docs.tutti-ai.com/contributing/overview/).

```bash
git clone https://github.com/tuttiai/tutti.git
cd tutti && npm install && npm run build
npx vitest run
```

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities to security@tutti-ai.com.

## License

Apache 2.0 &copy; [Tutti AI](https://tutti-ai.com)
