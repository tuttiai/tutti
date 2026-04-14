# @tuttiai/cli

CLI for [Tutti](https://tutti-ai.com) — scaffold and run multi-agent projects from the command line.

## Install

```bash
npm install -g @tuttiai/cli
```

## Commands

### `tutti-ai init [project-name]`

Scaffold a new Tutti project with a ready-to-run `tutti.score.ts`:

```bash
tutti-ai init my-project
cd my-project
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm install
npm run dev
```

### `tutti-ai run [score]`

Load a score file and open an interactive REPL:

```bash
tutti-ai run                     # defaults to ./tutti.score.ts
tutti-ai run ./custom-score.ts   # specify a score file
tutti-ai run --watch             # hot-reload the score on file changes
tutti-ai run -w ./score.ts       # short alias
```

Features:
- Spinner on LLM calls
- Colored tool execution trace
- Session continuity across messages
- Graceful Ctrl+C handling
- Hot reload with `--watch` / `-w` (see below)

#### Watch mode

`--watch` reloads the score (and any file in the score's directory tree,
excluding `node_modules`, `dist`, and dotfiles) whenever it changes on
disk. Changes are debounced 200ms so editor saves that touch the file
multiple times collapse into a single reload.

```
> research quantum computing
[tutti] Score changed, reloading...
[tutti] Score reloaded. Changes applied.
> what did you learn last turn?
```

Semantics:

- **Changes take effect at turn boundaries**, never mid-tool-call. The
  current turn always completes with the config it started with; the
  next turn reads the new config.
- **Session history is preserved** across reloads — the REPL's
  `session_id` carries over, so the conversation continues.
- **Syntax errors are recovered** — if the reload fails to parse or
  validate, the error is printed and the REPL keeps using the previous
  config. Fix the file and save again.
- **Trade-off**: runtime internals (tool cache, semantic memory) reset
  on reload. Conversation history survives because the REPL owns the
  session store and reuses it across runtime swaps.

Deferred (known gaps):
- The watcher uses a directory-tree watch, not a resolved import graph —
  unrelated file edits in the project tree will also trigger reloads.
  A future revision may use `madge` or the TS compiler API for
  precision.
- Voice-level partial reload isn't implemented; the whole runtime is
  rebuilt on every change. Fast enough in practice (typically <50ms)
  but means runtime-internal caches reset.

### `tutti-ai serve [score]`

Start the Tutti HTTP server — exposes your score as a REST API:

```bash
tutti-ai serve                          # defaults to ./tutti.score.ts
tutti-ai serve ./custom-score.ts        # specify a score file
tutti-ai serve --port 8080              # custom port (default: 3847)
tutti-ai serve --watch                  # hot-reload score on file changes
tutti-ai serve -a researcher            # expose a specific agent
```

Options:

| Flag | Default | What it does |
|---|---|---|
| `-p, --port <number>` | `3847` | Port to listen on. |
| `-H, --host <address>` | `0.0.0.0` | Interface to bind to. |
| `-k, --api-key <key>` | `TUTTI_API_KEY` env | Bearer token clients must send for auth. |
| `-a, --agent <name>` | score entry or first agent | Which agent to expose via the API. |
| `-w, --watch` | off | Reload the score and restart the server on file changes. |

Startup output:

```
  Tutti Server v0.1.0
  http://localhost:3847

  Score:  my-project
  Agent:  assistant
  Agents: assistant, researcher
  Watch:  enabled

  Endpoints:
    POST  http://localhost:3847/run
    POST  http://localhost:3847/run/stream
    GET   http://localhost:3847/sessions/:id
    GET   http://localhost:3847/health
```

#### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TUTTI_API_KEY` | Yes | Bearer token for authenticating requests. |
| `ANTHROPIC_API_KEY` | If using Anthropic | Anthropic API key. |
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key. |
| `GOOGLE_API_KEY` | If using Gemini | Google AI API key. |
| `TUTTI_ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: `*`). |
| `DATABASE_URL` | No | PostgreSQL URL for session persistence. |
| `TUTTI_REDIS_URL` | No | Redis URL for durable checkpoints. |

#### Example curl commands

```bash
# Health check
curl http://localhost:3847/health

# Run an agent (non-streaming)
curl -X POST http://localhost:3847/run \
  -H "Authorization: Bearer $TUTTI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "Summarize the latest AI news"}'

# Run an agent (streaming via SSE)
curl -N -X POST http://localhost:3847/run/stream \
  -H "Authorization: Bearer $TUTTI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "Write a short poem about TypeScript"}'

# Continue a conversation
curl -X POST http://localhost:3847/run \
  -H "Authorization: Bearer $TUTTI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "Tell me more", "session_id": "<session_id from previous response>"}'

# Retrieve session history
curl http://localhost:3847/sessions/<session_id> \
  -H "Authorization: Bearer $TUTTI_API_KEY"
```

#### Graceful shutdown

`SIGINT` (Ctrl+C) and `SIGTERM` close the server after in-flight requests
complete. Fastify's built-in connection draining ensures no request is
dropped mid-response.

#### Watch mode

`--watch` reloads the score on any file change in the score's directory
tree (debounced 200ms). On reload the server is closed and restarted
with the new config. In-flight sessions survive because the session
store is shared across restarts.

### `tutti-ai resume <session-id>`

Resume a crashed or interrupted run from its last durable checkpoint.
Requires the agent to have been configured with `durable: true` on the
original run, and a Redis or Postgres backend reachable via the matching
env var.

```bash
# Redis-backed checkpoint
export TUTTI_REDIS_URL=redis://127.0.0.1:6379/0
tutti-ai resume 811b3b38-9a1d-4b98-ab7d-57e4acaecdea --store redis

# Postgres-backed checkpoint
export TUTTI_PG_URL=postgres://localhost/tutti
tutti-ai resume 811b3b38-9a1d-4b98-ab7d-57e4acaecdea --store postgres
```

Options:

| Flag | Default | What it does |
|---|---|---|
| `--store <backend>` | `redis` | Which durable store the checkpoint was written to (`redis` or `postgres`). |
| `-s, --score <path>` | `./tutti.score.ts` | Score file to load — must match the one the original run used. |
| `-a, --agent <name>` | `score.entry` or the first agent | Which agent to resume. |
| `-y, --yes` | false | Skip the confirmation prompt (useful for scripts). |

The command prints a summary (last completed turn, timestamp, first few
messages) and asks `Resume from turn N? (y/n)` before handing off. On
confirm it loads the score, reattaches the checkpoint store, seeds the
session, and calls the runtime — picking up exactly where the previous
run left off. Saying `n` exits without running anything.

Typical flow after a crash:

```bash
$ tutti-ai run ./my-score.ts
> research recent AI papers
· Checkpoint saved at turn 1
· Checkpoint saved at turn 2
[process crashes / SIGKILL]

$ tutti-ai resume 811b3b38-9a1d-4b98-ab7d-57e4acaecdea --store redis

Checkpoint summary
  Session ID:    811b3b38-9a1d-4b98-ab7d-57e4acaecdea
  Last turn:     2
  Saved at:      2026-04-13T15:47:12.031Z
  Messages:      5 total

First messages
  [user] research recent AI papers
  [assistant] [tool_use search_web]
  [user] [tool_result {"results":[…]}]

Resume from turn 2? (y/n) y
↻ Restored from turn 2 (session 811b3b38…)
✓ Resumed run complete.
  Final turn:    3
```

### `tutti-ai schedule [score]`

Start the scheduler daemon — reads a score file, registers all agents
that have a `schedule` config, and runs on their configured triggers
(cron, interval, or one-shot datetime) until the process is killed.

```bash
tutti-ai schedule                     # defaults to ./tutti.score.ts
tutti-ai schedule ./custom-score.ts   # specify a score file
```

Score file example:

```ts
const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    reporter: {
      name: "Reporter",
      system_prompt: "Generate a daily status report.",
      voices: [],
      schedule: {
        cron: "0 9 * * *",           // 9 AM daily
        input: "Generate the daily status report",
        max_runs: 30,                 // auto-disable after 30 runs
      },
    },
  },
});
```

Environment:

| Variable | Required | Description |
|---|---|---|
| `TUTTI_PG_URL` | Recommended | PostgreSQL URL for durable schedule persistence. Falls back to in-memory (lost on restart). |

The daemon logs `schedule:triggered`, `schedule:completed`, and
`schedule:error` events to stdout with timestamps.

### `tutti-ai schedules list`

Show all registered schedules:

```bash
tutti-ai schedules list
```

Output:

```
  ID                  AGENT           TRIGGER               ENABLED   RUNS    CREATED
  ──────────────────────────────────────────────────────────────────────────────────────
  nightly-report      reporter        cron: 0 9 * * *       yes       12      2026-04-14
  health-check        monitor         every 30m             yes       48/100  2026-04-14
```

### `tutti-ai schedules enable <id>`

Re-enable a disabled schedule:

```bash
tutti-ai schedules enable nightly-report
```

### `tutti-ai schedules disable <id>`

Disable a schedule without deleting it:

```bash
tutti-ai schedules disable nightly-report
```

### `tutti-ai schedules trigger <id>`

Manually trigger a scheduled run immediately (useful for testing):

```bash
tutti-ai schedules trigger nightly-report
tutti-ai schedules trigger nightly-report --score ./custom-score.ts
```

### `tutti-ai schedules runs <id>`

Show run history for a schedule (last 20 runs):

```bash
tutti-ai schedules runs nightly-report
```

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/cli)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
