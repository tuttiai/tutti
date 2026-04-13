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

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/cli)
- [Docs](https://tutti-ai.com/docs)

## License

MIT
