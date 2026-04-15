# Changelog

## [Unreleased]

### Added — Interrupt approval endpoints in `@tuttiai/server`
- `GET /sessions/:sessionId/interrupts` — every interrupt request for a session regardless of status, oldest first.
- `GET /interrupts/pending` — every pending request across every session. Powers monitoring dashboards.
- `POST /interrupts/:interruptId/approve` — body `{ resolved_by?: string }`. 404 on unknown id; 409 with current record in body on already-resolved; 200 with the resolved request on success. Wakes the suspended tool call in the runtime.
- `POST /interrupts/:interruptId/deny` — body `{ reason?: string; resolved_by?: string }`. Same 404/409 handling. Throws `InterruptDeniedError` into the waiting run, which the server's error handler maps to a 4xx/5xx on the original `/run` request with the denial reason in the body.
- `GET /interrupts/stream` — Server-Sent Events. Forwards every `interrupt:requested` and `interrupt:resolved` event as a JSON frame of `{ type, data: InterruptRequest }`. Fetches the full record from the store on each event so the wire shape is authoritative and matches the REST endpoints. (SSE chosen over WebSocket to match the existing `/run/stream` + `/traces/stream` transport — no new dep.)
- Every non-stream route returns 503 with a clear `interrupt_store_not_configured` error when the runtime has no store, rather than silently 404-ing forever.
- `TuttiRuntime.interruptStore` exposed as a readonly public getter so server routes and dashboards can reach it without a second injection surface.
- `InterruptStore.listBySession(session_id)` added to the interface — returns every request for a session regardless of status. Implemented by both `MemoryInterruptStore` and `PostgresInterruptStore`.
- 13 server integration tests (cross-session listing, per-session listing with mixed statuses, full end-to-end approval + denial through a real agent loop, 404 / 409 / 503 / 401 error paths, empty-body deny) plus 4 new core tests for `listBySession`.

### Added — Human-in-the-loop interrupt system in `@tuttiai/core`
- `AgentConfig.requireApproval?: string[] | "all" | false` — gate specific tool calls behind operator approval. Glob patterns (`*` is the only wildcard), `"all"` to gate every call, or `false` (default) to opt out.
- New `InterruptStore` interface with `create` / `get` / `resolve` / `listPending`. `resolve` is idempotent on already-resolved ids; `listPending` is oldest-first and optionally filtered by `session_id`.
- `MemoryInterruptStore` for dev / tests; `PostgresInterruptStore` for production on the `tutti_interrupts` table (auto-created; partial index on the pending set keeps review-queue polls fast).
- Runtime integration: when a tool call matches an agent's `requireApproval` patterns, `AgentRunner` creates an `InterruptRequest`, emits `interrupt:requested`, and suspends execution until `TuttiRuntime.resolveInterrupt(id, "approved" | "denied", options?)` is called. Approval resumes the call with the validated args (bypasses the tool-result cache so repeat calls still prompt); denial throws `InterruptDeniedError` which aborts the run with the operator's `denial_reason`.
- Approval check runs *after* Zod validation (so stored `tool_args` are the parsed shape reviewers see) and *before* cache lookup. The resolver is registered synchronously before the `interrupt:requested` event fires, so a handler that calls `resolveInterrupt` immediately still lands on a waiter.
- New `interrupt:requested` and `interrupt:resolved` events.
- New `InterruptDeniedError` in the error hierarchy (code `INTERRUPT_DENIED`; `tool_name` / `reason` / `interrupt_id` as public fields).
- 32 new tests: 13 for glob matching, 11 for `MemoryInterruptStore`, 8 end-to-end through `AgentRunner` (approval + denial + `"all"` + non-matching pass-through + `false` + missing-store error + idempotent resolve), plus 10 Postgres integration tests gated by `TUTTI_PG_URL`.

### Added — `tutti-ai memory` CLI commands
- `tutti-ai memory list --user <id>` — table of every memory for a user, sorted by `(importance DESC, created_at DESC)`. Columns: id (8-char prefix), content (truncated to 60 chars), source (green=explicit / yellow=inferred), importance (★☆☆ / ★★☆ / ★★★), created.
- `tutti-ai memory search --user <id> <query>` — query the user's memories; preserves the store's relevance ranking; header reproduces the query and pluralised result count.
- `tutti-ai memory add --user <id> <content> [--importance 1|2|3]` — manually store a memory with `source: "explicit"`. Default importance is 2.
- `tutti-ai memory delete --user <id> <memory-id>` — delete a single memory. `--user` is required for symmetry / accident-prevention even though the store keys on id alone.
- `tutti-ai memory clear --user <id>` — counts first, then prompts via Enquirer ("Delete all N memories for user <id>?"); cancels on no.
- `tutti-ai memory export --user <id> [--format json|csv] [-o <path>]` — JSON (pretty-printed) or RFC-4180-ish CSV (tags joined with `;`). Streams to stdout when `--out` is omitted so output can be piped to `jq` / `xsv`.
- All commands resolve the store the same way as the runtime: `TUTTI_PG_URL` → `PostgresUserMemoryStore`; otherwise warn loudly ("memories are ephemeral; this command will appear to do nothing useful") and fall back to `MemoryUserMemoryStore`.
- Pure rendering logic split into `memory-render.ts` (under coverage); orchestration in `memory.ts` (excluded from coverage like other I/O-heavy commands).
- 21 unit tests cover star bars, list table (header / empty state / sort order / truncation / source colours / star bars), search rendering (query header / pluralisation / order preservation / empty state), confirmation lines, JSON export, and CSV export (RFC-4180 escaping / tag joining / empty fields / header-only).

### Added — User memory wired into the agent runtime
- `AgentRunner.run()` and `TuttiRuntime.run()` accept a 4th `options?: AgentRunOptions` argument carrying `user_id` (and `session_id` as the design-time migration target). Positional `session_id` still accepted for back-compat; positional wins on conflict.
- **Injection:** when `user_id` is set AND the agent has `memory.user_memory` configured, `UserMemoryStore.search(user_id, input, inject_limit)` runs once before the first turn and the results are appended to the system prompt as a `What I remember about you:\n- ... [importance: high|normal|low]` section. Search failures are logged and non-fatal — the run continues with no injected memories.
- **Tool-context binding:** `ToolContext.user_memory.remember(content, options?)` is exposed to tool code with `user_id` bound implicitly. Stores with `source: "explicit"` and `importance: 3` by default (deliberate intent), overridable via the options bag. `ToolContext.user_id` also surfaces the active end-user id for tools that need it directly.
- **Auto-infer:** when `agent.memory.user_memory.auto_infer === true`, after the run completes the runtime sends the last 10 messages with the spec's extraction prompt, parses the response (tolerates code-fenced JSON / leading prose), and stores each fact with `source: "inferred"`, `importance: 2`. Failures at every layer (LLM call, JSON parse, individual store write) are logged and swallowed — auto-infer is best-effort.
- `TuttiRuntime.setUserMemoryStore(agent_name, store)` lets callers inject a custom store (e.g. a metrics-wrapped backend) without going through the per-agent `createUserMemoryStore` factory.
- `ToolContext` extended with optional `user_memory?: UserMemoryToolHelpers` and `user_id?: string`. New `UserMemoryToolHelpers` interface in `@tuttiai/types`.
- 15 integration tests cover injection (presence + format + position + limit + the off-paths), the tool-context `remember` helper (defaults + every option + absence when `user_id` is unset), and auto-infer (extraction prompt + storage attributes + JSON tolerance + every failure mode).

### Added — User memory backends in `@tuttiai/core`
- `MemoryUserMemoryStore` — `Map<user_id, UserMemory[]>` backend for dev / tests / ephemeral demos. Substring search ranked by `importance DESC, created_at DESC`; bumps `last_accessed_at` on every hit; per-user cap (default 200) evicts the worst memories first (lowest `importance`, then oldest within that band — including just-stored memories that rank lowest). **Documented as dev-only — no encryption, no persistence, no access control beyond `user_id` keying.**
- `PostgresUserMemoryStore` — production backend on the `tutti_user_memories` table (created on first use, idempotent, table name validated against `^[a-z_][a-z0-9_]*$`). Trigram detection runs once at bootstrap via `pg_extension WHERE extname = 'pg_trgm'`; if available, search uses the `%` operator + `similarity()` ranking; falls back to `ILIKE`. Every `store()` call fires (and does not await) a sweep that deletes globally-expired rows + an `enforceCap` pass that trims back to `max_memories_per_user`. In-band expiry filtering on `search` / `list` / `get` so reads stay correct even when sweeps lag.
- `createUserMemoryStore(config)` factory dispatches on `config.store` (`"memory"` / `"postgres"`); reads `TUTTI_PG_URL` for the Postgres backend with a friendly error when missing.
- New exports from `@tuttiai/core`: `MemoryUserMemoryStore`, `PostgresUserMemoryStore`, `createUserMemoryStore`, `DEFAULT_MAX_MEMORIES_PER_USER`, plus the option types and the design types from the previous commit.
- 28 unit tests cover the in-memory backend end-to-end. 16 integration tests cover the Postgres backend, gated by `TUTTI_PG_URL` (skip cleanly without it, exactly like the existing checkpoint integration suite).

### Added — Span exporter pipeline in `@tuttiai/telemetry`
- New `packages/telemetry/src/exporters/` module — pluggable `SpanExporter` interface (`export(span)` / `flush()` / `shutdown()`). Contract: never throws, fire-and-forget; concrete exporters buffer + flush asynchronously.
- `OTLPExporter` — buffered, retry-aware OTLP/HTTP JSON exporter for Jaeger, Datadog, Honeycomb, and any OTLP collector. Flushes on size (default 100 spans) or interval (default 5 s); 3 retries with 1s/2s/4s exponential backoff on network errors and 5xx; 4xx is permanent and dropped. Concurrent flush coalescing prevents double-POST. `unref()` on the timer so the exporter never keeps the process alive. Uses `JsonTraceSerializer` from `@opentelemetry/otlp-transformer` via a `TuttiSpan → ReadableSpan` adapter (UUID → 32-char trace id, first 16 hex chars → span id).
- `JsonFileExporter` — newline-delimited JSON file exporter. Single append-mode `WriteStream` opened lazily on first write; one JSON object per line with `Date` fields serialised as ISO strings. Useful for offline analysis (`jq`, DuckDB) and CI eval artefacts.
- `configureExporter(exporter | undefined)` — hooks the singleton tracer's subscribe API and forwards every emitted span. Returns a teardown function. Calling with a new exporter when one is attached shuts the prior one down cleanly. `getActiveExporter()` for diagnostics.
- New deps in `@tuttiai/telemetry`: `@opentelemetry/api`, `@opentelemetry/core`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/otlp-transformer`. Previously zero-dep.

### Added — Score-level exporter configuration
- `TelemetryConfig.otlp?: { endpoint: string; headers?: Record<string,string> }` — auto-installs an `OTLPExporter` at runtime construction.
- `TelemetryConfig.jsonFile?: string` — auto-installs a `JsonFileExporter` writing to the given path.
- `TelemetryConfig.disabled?: boolean` — short-circuits the exporter pipeline entirely; wins over score-file `otlp` / `jsonFile` and the env vars below.
- `TUTTI_OTLP_ENDPOINT` env var → installs `OTLPExporter`. Beats score-file config so operators can override without editing the score.
- `TUTTI_TRACE_FILE` env var → installs `JsonFileExporter`. Same precedence rules.
- `TuttiRuntime.shutdown()` — drains buffered spans before process exit. Long-running processes (servers, schedulers) should call this on SIGTERM.
- The new fields are independent of the existing `enabled`/`endpoint`/`headers` (those still gate the OpenTelemetry SDK auto-instrumentation; the new fields gate the in-process `TuttiSpan` exporter pipeline).

### Added — `tutti-ai traces` CLI commands
- `tutti-ai traces list` — table of the last 20 traces (most recent first) with columns: trace id (8-char prefix), agent id, started at, duration, status, total tokens, cost.
- `tutti-ai traces show <trace-id>` — full span tree as an indented hierarchy with kind icons (▶ agent, ◆ llm, ⚙ tool, 🛡 guardrail, 💾 checkpoint), chalk colors (green=ok, red=error, yellow=running), and a summary footer (token total, cost, root-span wall time).
- `tutti-ai traces tail` — live SSE tail; each span prints as it opens and as it closes. Ctrl+C to exit.
- All three subcommands accept `--url` (default `http://127.0.0.1:3847`, falls back to `TUTTI_SERVER_URL`) and `--api-key` (falls back to `TUTTI_API_KEY`). Friendly errors on 401, 404, and connection failures.
- Pure rendering logic split into `traces-render.ts` (under coverage); orchestration in `traces.ts` (excluded from coverage like other I/O-heavy commands).
- 13 unit tests covering empty state, table headers, ordering, 20-row limit, status colors, em-dashes for missing fields, indented tree, transitive nesting, footer summary, error surfacing, running-state rendering, span-kind icons, indent math.

### Added — `/traces` route family in `@tuttiai/server`
- `GET /traces` — last 20 trace summaries from the in-process `getTuttiTracer()` singleton.
- `GET /traces/:id` — every span belonging to one trace; 404 when unknown. `Date` fields serialise as ISO strings for stable JSON round-trips.
- `GET /traces/stream` — Server-Sent Events; subscribes to `getTuttiTracer().subscribe()` on connect, unsubscribes on socket close. Each span pushed twice (once on open with `status: "running"`, once on close with `ok` / `error`).
- All three endpoints inherit the existing bearer-token auth middleware.

### Added — Span retrieval helpers in `@tuttiai/telemetry`
- `TuttiTracer.getAllSpans(): TuttiSpan[]` — defensive copy of every span in the ring buffer, in insertion order. Lets exporters / UIs render a list of recent traces without having to know trace ids in advance.
- `buildTraceSummaries(spans, limit?): TraceSummary[]` — groups raw spans by `trace_id`, derives root-span metadata (agent id, status, duration, started_at), aggregates `llm.completion` token + cost data. Skips orphan fragments where the root has been evicted from the ring buffer. Sorts most-recent-first; trims to `limit` (default 20).
- `TraceSummary` type re-exported from `@tuttiai/core`.

### Added — Per-run cost estimation in `@tuttiai/telemetry`
- `MODEL_PRICES` table seeded with public USD-per-1M-token rates for `gpt-4o`, `gpt-4o-mini`, `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-3-5`, `gemini-2-0-flash`. Frozen — mutate via `registerModelPrice(model, inputPer1M, outputPer1M)`.
- `estimateCost(model, promptTokens, completionTokens): number | null` — model-aware cost calculator. Returns `null` for unregistered models so callers can detect missing pricing rather than silently falling back to zero.
- `getRunCost(traceId, tracer?): RunCost` — aggregates every `llm.completion` span in a trace. Returns `{ prompt_tokens, completion_tokens, total_tokens, cost_usd }`. `cost_usd` is `null` only when *no* span had a known cost; mixed runs return the partial sum of known costs. Defaults to the singleton tracer.
- `getTuttiTracer()` singleton accessor moved into `@tuttiai/telemetry` (was in core). Core now re-exports — same instance is shared across packages.
- Per-call `cost_usd` is automatically recorded on every `llm.completion` span by the runtime's instrumentation.
- Per-run `cost_usd` is automatically attached to `AgentResult.usage` so consumers get cost data without importing `@tuttiai/telemetry` directly.
- `TokenUsage.cost_usd?: number` (optional addition, non-breaking).
- `MODEL_PRICES`, `estimateCost`, `getRunCost`, `registerModelPrice`, `ModelPrice`, `RunCost` re-exported from `@tuttiai/core`.
- 15 new unit tests in `cost.test.ts`, 3 new integration tests in `telemetry-integration.test.ts`.

### Added — `@tuttiai/telemetry@0.1.0` (in-process span tracer)
- New `packages/telemetry` package — zero runtime deps beyond Node built-ins. Exports `TuttiTracer`, `TuttiSpan`, `TuttiSpanAttributes`, `SpanKind`, `SpanStatus`, `GuardrailAction`.
- `TuttiTracer` class: `startSpan(name, kind, attributes?, parent_span_id?)`, `endSpan(span_id, status, extra_attributes?, error?)`, `getTrace(trace_id)`, `subscribe(cb)`. Bounded ring buffer (default 1000 spans, configurable via `max_spans`).
- Span tree: child spans inherit `trace_id` from a known parent; orphan parents get a fresh trace id. Subscriber exceptions are isolated so a noisy listener can't break the agent loop.
- 19 unit tests, 100% coverage on `tracer.ts`.

### Added — Automatic agent runtime tracing in `@tuttiai/core`
- New `@tuttiai/telemetry` workspace dep. Every agent run now emits a span tree with zero user configuration.
- Spans emitted: `agent.run` (root, with `agent_id` / `session_id` / `model`), `llm.completion` (per provider call, with `prompt_tokens` / `completion_tokens` / `total_tokens`), `tool.call` (with `tool_name` / `tool_input` / `tool_output`), `guardrail` (around `beforeRun` and `afterRun` with `guardrail_action`: `pass` / `redact` / `block`), `checkpoint` (around durable save/restore).
- Parent span propagation via `AsyncLocalStorage` — concurrent runs stay isolated, every nested span has the correct `parent_span_id`.
- Existing OpenTelemetry spans are preserved alongside the new in-process tracer (dual emission for back-compat).
- New exports: `getTuttiTracer()` (singleton accessor), `getCurrentTraceId()`, `getCurrentSpanId()`. The canonical `TuttiTracer` class and span types are re-exported from `@tuttiai/telemetry`.
- `AgentResult.trace_id` (optional) — set on every successful run, lets callers retrieve the full trace via `getTuttiTracer().getTrace(trace_id)`.
- 12 new integration tests covering span emission, nesting, attributes, trace propagation, guardrail action recording, concurrent-run isolation, and subscriber error isolation.

### Breaking
- The `TuttiTracer` re-export from `@tuttiai/core` is now the `TuttiTracer` *class* from `@tuttiai/telemetry`, not the previous OpenTelemetry-wrapper *object*. Callers using `TuttiTracer.agentRun(...)` / `.llmCall(...)` / `.toolCall(...)` directly should switch to `getTuttiTracer()` for the singleton instance, or rely on the automatic tracing now built into `AgentRunner`.

## [0.20.0] - 2026-04-14

Four major features: graph-based routing, input/output guardrails, native scheduling, and time-travel debugging. 398 tests across the monorepo.

### Added — TuttiGraph (graph-based agent routing)
- `TuttiGraph` execution engine with `run()` and `stream()` — linear chains, conditional branching (first-match edge evaluation), loop edges with per-node visit cap (`max_node_visits`, default 5, throws `GraphCycleError`), and parallel forks via `GraphEdge.parallel` with `GraphNode.merge` join points. Shared Zod-validated state with `state_update` shallow-merge.
- `defineGraph(entrypoint)` fluent DSL builder — `.node()`, `.edge()`, `.state()`, `.build()` chain for constructing `GraphConfig` in score files.
- `renderGraph(config)` — self-contained HTML page with D3-force interactive SVG and static `<noscript>` fallback. `graphToJSON(config)` for API serialisation.
- Server `GET /graph` endpoint on `@tuttiai/server` when `ServerConfig.graph` is provided.
- Graph events: `node:start`, `node:end`, `edge:traverse`, `state:update`, `graph:start`, `graph:end`.
- Graph errors: `GraphValidationError`, `GraphCycleError`, `GraphStateError`, `GraphDeadEndError`.

### Added — Guardrails (input/output safety)
- `AgentConfig.beforeRun` and `AgentConfig.afterRun` hooks — modify text, pass through, or throw `GuardrailError` to abort.
- Three built-in factories: `profanityFilter()` (word-list replacement), `piiDetector("redact" | "block")` (email, phone, SSN, credit card regex), `topicBlocker(topics)` (cosine-similarity blocking).
- `GuardrailError` error class with `GUARDRAIL_BLOCKED` code.

### Added — Structured output
- `AgentConfig.outputSchema` (Zod schema) + `AgentConfig.maxRetries` (default 3). Appends JSON-schema instruction to system prompt, validates final output, retries on parse failure.
- `AgentResult.structured` populated on success. `StructuredOutputError` thrown after exhausted retries.

### Added — Scheduled agents
- `SchedulerEngine` with `schedule()`, `trigger()`, `start()`, `stop()`. Cron expressions (via `node-cron`), interval shorthand (`"1h"`, `"30m"`), and one-shot ISO datetime triggers.
- `max_runs` auto-disables after N runs. Store backends: `MemoryScheduleStore` (dev), `PostgresScheduleStore` (production, table: `tutti_schedules`).
- Events: `schedule:triggered`, `schedule:completed`, `schedule:error`.
- `AgentConfig.schedule` field and `AgentScheduleConfig` type.
- CLI: `tutti-ai schedule [score]` daemon, `tutti-ai schedules list|enable|disable|trigger|runs` management.

### Added — Time-travel debugging
- `tutti-ai replay <session-id>` — interactive REPL for navigating session history from PostgreSQL.
- Commands: `list`, `show <n>`, `next`/`prev`, `inspect`, `replay-from <n>` (re-run with original or new input), `export json|md`.

### Package versions
- `@tuttiai/types` 0.9.0
- `@tuttiai/core` 0.14.0
- `@tuttiai/cli` 0.13.0

## [0.19.0] - 2026-04-14

Three new packages: REST API server, web search voice, and code execution sandbox.
172 new tests. Docker deployment support. `tutti-ai serve` CLI command.

### Added — `@tuttiai/sandbox@0.1.0` (code execution voice)
- New `voices/sandbox` package — 4 tools: `execute_code`, `read_file`, `write_file`, `install_package`.
- `SandboxConfig`: `{ allowed_languages?, allowed_packages?, timeout_ms?, max_file_size_bytes?, env?, install_timeout_ms? }`.
- `allowed_languages` restricts the `execute_code` Zod enum at construction time — disallowed languages are rejected by schema validation before execution.
- `max_file_size_bytes` (default 1 MB) — `write_file` rejects content exceeding the limit.
- Per-session filesystem sandbox: creates `/tmp/tutti-sandbox/{session_id}/` on `setup()`, deletes on `teardown()`. `SandboxEscapeError` for `../../` traversal; error message never leaks host paths.
- `install_package(name, manager?)`: `npm --prefix` or `pip --target` into sandbox. Optional `allowed_packages` allowlist. Shell metachar validation.
- Core executor: `child_process.spawn` with `detached: false`, SIGKILL on timeout, `.mts` extension for TypeScript ESM, ANSI stripping, 10 KB truncation, path redaction.
- E2E test: write → execute TypeScript Fibonacci → read output file → assert contains 55.
- 67 unit tests across 6 files covering all languages, timeout, truncation, path traversal, file size limits, language restrictions, sandbox lifecycle, and end-to-end Fibonacci.

### Added — `@tuttiai/web@0.1.0` (web voice)
- New `voices/web` package — gives agents 3 tools: `web_search`, `fetch_url`, `fetch_sitemap`.
- `WebVoiceConfig` — `{ provider?, cache?, max_results?, rate_limit?, timeout_ms? }`. Provider accepts `"brave" | "serper" | "duckduckgo"` string or a custom `SearchProvider` instance. `max_results` sets the default result count for `web_search` (1–20, default 5).
- `web_search` tool: three provider backends (Brave, Serper, DuckDuckGo) with auto-selection, normalised `SearchResult[]` output, graceful error handling, configurable `timeout_ms` (default 5s).
- `fetch_url` tool: fetches a URL with 10s timeout, detects content type. HTML → readable text via `@mozilla/readability` + `linkedom`. JSON → pretty-printed. Text/markdown → as-is. Truncated to ~8 000 tokens.
- `fetch_sitemap` tool: fetches sitemap.xml, parses `<loc>` entries from both `<urlset>` and `<sitemapindex>` formats. Appends `/sitemap.xml` to bare URLs.
- In-memory LRU cache: 500 entries max, 10 min TTL search, 30 min TTL fetch/sitemap. All three tools cache results by SHA-256 key.
- Per-tool rate limiting via sliding-window counter: `rate_limit: { per_minute: N }` returns `is_error: true` when budget exceeded.
- SSRF guard: rejects loopback, private-range, non-http(s) URLs.
- 63 unit tests across 5 files covering all providers, factory, all three tools, caching, truncation, rate limiting, error handling, and SSRF protection.

### Added — `@tuttiai/cli@0.11.0` `tutti-ai serve` command
- New `tutti-ai serve [score]` command starts the HTTP server from a score file.
- Options: `--port` (default 3847), `--host` (default 0.0.0.0), `--api-key`, `--agent`, `--watch`.
- Prints startup banner with server version, score name, agent, and endpoint list.
- `--watch` mode: ReactiveScore hot-reloads the score on file changes; the server is closed and restarted with the new config while preserving the in-memory session store.
- Graceful shutdown on SIGINT/SIGTERM: Fastify connection draining finishes in-flight requests before exit.
- CLI README updated with full usage guide, environment variable reference, and example curl commands for every endpoint.

### Added — Docker & deployment
- Multi-stage `Dockerfile` (Node 20 Alpine): builder → deps → runner. Runs as non-root user `tutti` (uid 1001). HEALTHCHECK via `wget` every 30s against `/health`. ~333MB final image.
- `packages/server/src/start.ts` — standalone entry point for Docker; reads all config from env vars (`TUTTI_PROVIDER`, `TUTTI_MODEL`, `TUTTI_SYSTEM_PROMPT`, `TUTTI_AGENT_NAME`, `TUTTI_PORT`, `TUTTI_HOST`). Built as `dist/start.js` alongside the library.
- `docker-compose.yml` — three services (`tutti`, `postgres` via pgvector/pgvector:pg16, `redis:7-alpine`) on a shared `tutti-net` network with persistent volumes.
- `.env.example` — documents all environment variables.
- `.dockerignore` — excludes node_modules, dist, .git, docs, examples, coverage.
- `scripts/deploy/railway.json` — one-click Railway deploy config.
- `scripts/deploy/render.yaml` — one-click Render deploy config.
- README "Deploy in 60 Seconds" section with docker-compose quick-start.

### Added — `@tuttiai/server@0.1.0` (REST API)
- New `packages/server` package — the HTTP surface for `tutti-ai serve`.
- `createServer(config: ServerConfig): FastifyInstance` builds a Fastify 5 app with bearer-token auth, four REST endpoints, and Fastify-native JSON Schema validation.
- `ServerConfig` accepts a pre-built `TuttiRuntime` + `agent_name` (was `agent_config`), plus `port` (default 3847), `host` (127.0.0.1), optional `api_key` (falls back to `TUTTI_API_KEY`), optional `rate_limit`, and `timeout_ms` (default 120s).
- **`POST /run`** — run agent to completion; returns `{ output, session_id, turns, usage, cost_usd, duration_ms }`. Returns 504 with partial output on timeout.
- **`POST /run/stream`** — SSE endpoint emitting `turn_start`, `tool_call`, `tool_result`, `content_delta`, `turn_end`, `run_complete`, and `error` events. Uses PassThrough stream for inject()-compatible testing.
- **`GET /sessions/:id`** — returns session conversation history with timestamps.
- **`GET /health`** — returns `{ status, version, uptime_s }`.
- `src/middleware/auth.ts` — constant-time bearer-token verification; `/health` on public-paths allowlist; fail-closed when no key is configured.
- `src/middleware/rate-limit.ts` — `@fastify/rate-limit` wrapper; 60 req/min per API key by default; configurable via `ServerConfig.rate_limit: { max, timeWindow }`; `/health` exempted; 429 with `{ error, retry_after_ms, request_id }`.
- `src/middleware/cors.ts` — `@fastify/cors` wrapper; origins from `ServerConfig.cors_origins` → `TUTTI_ALLOWED_ORIGINS` env → `"*"` fallback; allows `Authorization` + `Content-Type` headers.
- `src/middleware/errors.ts` — global Fastify error handler; maps TuttiError subtypes to HTTP status codes (`AuthenticationError→401`, `AgentNotFoundError→404`, `PermissionError→403`, `ToolTimeoutError→504`, `BudgetExceededError→402`); hides stack traces in production; logs 5xx with request ID.
- `src/middleware/request-id.ts` — attaches `x-request-id` header to every response; echoes client-provided ID or generates UUID v4.
- `src/cost.ts` — Sonnet-class fallback cost estimator matching `agent-router.ts`.
- `createServer` is now async (required for Fastify plugin `register()` awaiting).
- 42 integration tests across 8 files covering all endpoints, middleware layers, auth, validation, timeout, SSE parsing, error mapping, CORS, rate limiting, and request ID propagation.

## [0.18.0] - 2026-04-13

### Added — `@tuttiai/cli@0.10.0` (hot reload)
- Add `--watch` / `-w` flag to `tutti-ai run` for hot reload on score file changes.
- New `ReactiveScore` wrapper (chokidar-backed, 200ms debounce) watches the score file plus its parent directory tree (excluding `node_modules`, `dist`, dotfiles). ESM cache is bypassed per reload via `?t=<timestamp>` cache-busting.
- Turn-boundary guarantee: reloads never interrupt a mid-tool-call. The REPL checks `reactive.pendingReload` at the top of each loop iteration and swaps the runtime only between turns.
- Session continuity: conversation `session_id` survives reloads — the REPL builds an `InMemorySessionStore` up front and reuses it across runtime swaps via the new `TuttiRuntimeOptions.sessionStore` override.
- Syntax-error recovery: a failed reload leaves `reactive.current` pointing at the last-known-good score, logs the error, and the REPL keeps running.
- Scope trade-offs documented in the README: directory-tree watch (not a resolved import graph — follow-up), full runtime rebuild on any change (in-runtime caches reset; conversation history survives via the shared session store).
- Adds `chokidar@5.0.0` as an exact-pinned CLI dependency.

### Added — `@tuttiai/core@0.11.0` and `@tuttiai/cli@0.9.0` (durable execution)

**Core**
- Add durable execution with checkpoint persistence via Redis and PostgreSQL.
- `CheckpointStore` interface with `save` / `loadLatest` / `load` / `delete` / `list`, plus three implementations:
  - `MemoryCheckpointStore` (test-only — nested Map with structuredClone on save/load).
  - `RedisCheckpointStore` (ioredis 5.10.1; `tutti:checkpoint:{session_id}:{turn}` + `:latest` pointer; pipeline-based save with `EX` TTL; `SCAN` for list/delete; per-command error checking on `pipeline.exec`).
  - `PostgresCheckpointStore` (pg 8.20.0; lazy `CREATE EXTENSION` not needed — uses a plain JSONB column; auto-creates `tutti_checkpoints` + session/expires indexes on first use; transactional UPSERT with global-expiry sweep and per-session trim to the 10 most-recent turns).
- `createCheckpointStore(config: AgentDurableConfig)` factory dispatching on `config.store`, reading `TUTTI_REDIS_URL` / `TUTTI_PG_URL` via `SecretsManager.optional`.
- `AgentConfig.durable?: boolean | AgentDurableConfig` — per-agent opt-in. `AgentDurableConfig` carries `{ store: "redis" | "postgres" | "memory", ttl?: number }` (default 604800 s = 7 days). Exported from `@tuttiai/types`.
- `AgentRunner` integration: on entry, if `durable` is truthy and `loadLatest` returns a mid-cycle checkpoint (`state.awaiting_tool_results === true`), restore messages + turn counter + token usage and emit `checkpoint:restored`. At the bottom of the tool-use branch, build a `Checkpoint` and `save()` it; emit `checkpoint:saved`. Save failures log at error but don't abort the run — durability is best-effort per turn. A narrow try/catch around the agentic loop logs the last checkpointed turn on crash, then rethrows.
- `TuttiRuntime` constructor now accepts an optional `TuttiRuntimeOptions { checkpointStore? }` as a second argument (backwards-compatible — `new TuttiRuntime(score)` still works). New `runtime.sessions` getter for id-specific session seeding. `InMemorySessionStore` gains a non-interface `save(session)` method for the same reason.
- Two new `TuttiEvent` variants: `checkpoint:saved` and `checkpoint:restored`, both `{ session_id, turn }`.
- Tests: 18 unit tests for `MemoryCheckpointStore`, 6 factory unit tests, 7 Redis integration + 9 Postgres integration (`describe.skip` without `TUTTI_REDIS_URL` / `TUTTI_PG_URL`), plus constructor-level unit tests that always run. 1 new end-to-end integration test exercising crash-and-resume through the `AgentRunner`. Full core suite: 285 passing / 14 skipped.

**CLI**
- Add `tutti-ai resume <session-id>` command for resuming crashed sessions.
- Options: `--store redis|postgres` (default `redis`), `-s/--score`, `-a/--agent`, `-y/--yes`.
- Flow: load the score, validate API keys, resolve the target agent (explicit → `score.entry` → first key), load the checkpoint via `createCheckpointStore`, print a summary (session_id, last turn, timestamp, first 3 messages), prompt `Resume from turn N? (y/n)`, then hand off to `TuttiRuntime` (with the checkpoint store attached and the session pre-seeded) which triggers the `AgentRunner` resume path.
- Progress UX mirrors `run` plus two new lines on `checkpoint:restored` and `checkpoint:saved` events.
- README updated with env setup, full flag table, and a crash-and-resume walkthrough.

**Dependencies**
- New: `ioredis@5.10.1` (exact-pinned as a DB client per the security policy).

### Added — `@tuttiai/rag@0.1.0` (new voice)
- Add RAG voice with document ingestion, semantic search, hybrid search, and HyDE query expansion.
- Document ingestion from local paths, HTTP(S) URLs, and GitHub blob URLs (with PDF, Markdown, and plain-text parsers; SSRF-guarded network I/O).
- Three chunking strategies: `fixed` (tokens + overlap), `sentence`, `paragraph`.
- Three embedding providers — `OpenAIEmbeddingProvider` (`text-embedding-3-small`, batched ≤2048), `AnthropicEmbeddingProvider` (Voyage AI `voyage-3-lite`), `LocalEmbeddingProvider` (Ollama-compatible `/api/embeddings`). Every provider retries on 408/429/5xx with exponential backoff and returns L2-normalised vectors.
- Two vector stores — `MemoryVectorStore` (brute-force cosine, event-loop yielding every 1000 chunks) and `PgVectorStore` (pgvector; auto `CREATE EXTENSION vector` + table on first use; `<=>` ranking, JSONB `@>` filters).
- `SearchEngine` composing semantic search, optional HyDE query rewriting (via an injected `LlmFn`), BM25 keyword retrieval (`wink-bm25-text-search`), and Reciprocal Rank Fusion at k=60 for hybrid ranking.
- Four tools: `ingest_document`, `search_knowledge`, `list_sources`, `delete_source`.
- 90 unit/integration tests + 1 end-to-end test (pg integration skips when `RAG_PG_URL` is unset).

### Security
- **Cache poisoning prevention** — `ToolCache` keys are now scoped by `agent_name`, so a tool result cached by Agent A can no longer be consumed by Agent B. Agents sharing a name still share the cache (same trust domain).
- **EventBus handler isolation** — a throwing or rejecting event subscriber no longer crashes the agent run. Exceptions are logged at `warn` and sibling handlers keep firing.
- **Tool-call timer leak fixed** — `executeWithTimeout` now clears its watchdog `setTimeout` on the happy path instead of leaking a handle for the full `tool_timeout_ms` window after each successful tool call.

### Added
- 11 new tests — cache agent-scoping, `ttl_ms: 0`, `runParallel` with a single input, all-agents-fail, `parallel:complete` excludes failed agents, non-Error rejection, empty `agents[]` at construction time, EventBus handler-isolation (3 tests), and a regression guard for the timer leak.

### Docs
- Registered `guides/tool-caching` in the Starlight sidebar (was unreachable via nav).
- `api/overview.mdx` — `AgentRouter.runParallel` / `runParallelWithSummary` signatures, `ParallelAgentResult` / `ToolCache` / `AgentCacheConfig` / `ParallelEntryConfig` types, and the `TuttiRuntime.toolCache` field.
- `getting-started/core-concepts.mdx` — all v0.17 events (`cache:*`, `parallel:*`, `hitl:*`), a Tool Result Caching section, and a Parallel Execution section.

### Published
- `@tuttiai/core@0.11.0` — durable execution (Redis + Postgres checkpoint stores, `AgentRunner` integration, `TuttiRuntimeOptions`, checkpoint events).
- `@tuttiai/cli@0.10.0` — `tutti-ai resume <session-id>` + `--watch` / `-w` hot reload.
- `@tuttiai/rag@0.1.0` — new voice: ingestion, semantic + BM25 hybrid search with RRF fusion, optional HyDE, pgvector backend.

### Not republished
- `@tuttiai/types` — `AgentDurableConfig`, `AgentConfig.durable`, and the `checkpoint:saved` / `checkpoint:restored` event variants were added to the types package but no new version was cut. `@tuttiai/core@0.11.0` bundles these declarations inline via `tsup`'s DTS pipeline, so consumers importing from `@tuttiai/core` see the new shape correctly. Users importing directly from `@tuttiai/types` will see the v0.7.0 shape until a `0.8.0` republish lands.

## [0.17.0] - 2026-04-13

### Added
- Tool result caching: `ToolCache` interface + `InMemoryToolCache` (sha256 keys, 5-minute default TTL, 1000-entry LRU eviction); per-agent opt-in via `AgentConfig.cache` (`{ enabled, ttl_ms?, excluded_tools? }`); `TuttiRuntime` attaches an `InMemoryToolCache` by default, exposed as `runtime.toolCache`
- Built-in write-tool exclusion — `write_file`, `delete_file`, `move_file`, `create_issue`, `comment_on_issue` are never cached regardless of config (exported as `DEFAULT_WRITE_TOOLS`)
- New events: `cache:hit` and `cache:miss` (`{ agent_name, tool }`)
- `AgentRouter.runParallel(inputs, options?)` — fan out to multiple agents simultaneously with `Promise.all`; each agent gets its own session; failures are surfaced as synthetic `[error]` results so one failure never blocks the others; `options.timeout_ms` races each agent and cancels stragglers
- `AgentRouter.runParallelWithSummary(inputs, options?)` — same, but returns a full `ParallelAgentResult` (per-agent map + merged output + `total_usage`, `total_cost_usd`, `duration_ms`)
- `ParallelEntryConfig` (`{ type: 'parallel'; agents: string[] }`) accepted as `ScoreConfig.entry` — declarative fan-out; `router.run(input)` dispatches the input to every listed agent simultaneously and returns a merged `AgentResult`
- `ParallelAgentResult` type in `@tuttiai/types`
- New events: `parallel:start` (`{ agents }`) and `parallel:complete` (`{ results }`)
- Example: `examples/parallel-test.ts` — two analysts running simultaneously
- Docs: `docs/guides/tool-caching.mdx` + updated `docs/guides/multi-agent.mdx`

### Changed
- `ScoreConfig.entry` type widened to `string | ParallelEntryConfig` (backwards compatible — string form behaves identically)

### Published
- `@tuttiai/types@0.7.0`
- `@tuttiai/core@0.10.0`
- `tutti-ai@0.11.0`

## [0.16.0] - 2026-04-12

### Added
- 5 project templates: `minimal`, `coding-agent`, `research-agent`, `qa-pipeline`, `dev-team`
- `tutti-ai init --template <id>` flag for direct template selection
- Interactive template picker when no `--template` flag provided
- `tutti-ai templates` command listing all templates with descriptions
- Evaluation framework: `EvalCase`, `EvalAssertion`, `EvalResult`, `EvalReport` types
- 7 assertion types: `contains`, `not_contains`, `matches_regex`, `tool_called`, `tool_not_called`, `turns_lte`, `cost_lte`
- `EvalRunner` — runs suites against a score, checks all assertions, tracks cost
- Report formatters: `printTable` (stdout), `toJSON` (CI), `toMarkdown` (PR comments)
- `tutti-ai eval <suite.json>` command with `--ci` flag (exits 1 on failure)

### Published
- `@tuttiai/core@0.9.0`
- `@tuttiai/cli@0.8.0`
- `tutti-ai@0.10.0`

## [0.15.0] - 2026-04-12

### Added
- Human-in-the-loop: `request_human_input` built-in tool
- `allow_human_input` field on `AgentConfig` (default: false)
- HITL events: `hitl:requested`, `hitl:answered`, `hitl:timeout`
- `TuttiRuntime.answer(sessionId, answer)` API for non-CLI integrations
- CLI REPL shows yellow HITL prompt with numbered options
- `TuttiHooks` lifecycle interface with 6 hook points
- `HookContext` with agent_name, session_id, turn, metadata
- Global hooks on `ScoreConfig.hooks`, per-agent hooks on `AgentConfig.hooks`
- Hook errors caught and logged — never crash the agent
- Built-in factory: `createLoggingHook(logger)` — log all LLM/tool calls
- Built-in factory: `createCacheHook(store)` — cache tool results by hash
- Built-in factory: `createBlocklistHook(tools)` — block specific tools
- Built-in factory: `createMaxCostHook(usd)` — enforce cost limit
- ESLint setup with typescript-eslint + security plugin (0 errors)
- Test coverage thresholds enforced in CI via vitest v8 provider
- Typed error hierarchy: 13 error classes extending `TuttiError`
- Retry logic for `ProviderError` (exponential backoff, max 3 attempts)
- `RateLimitError` respects `retryAfter` header

### Published
- `@tuttiai/types@0.6.0`
- `@tuttiai/core@0.8.0`
- `tutti-ai@0.9.0`

## [0.14.0] - 2026-04-12

### Added
- `tutti-ai search <query>` — search the voice registry by name, description, or tags
- `tutti-ai voices` — list all official voices with install status
- `tutti-ai publish` — automated voice publishing (pre-flight checks, npm publish, registry PR)
- `tutti-ai publish --dry-run` — validate without publishing
- `@tuttiai/mcp` voice — MCP bridge wraps any MCP server as a Tutti voice
- `McpVoice` with stdio transport, dynamic tool discovery, and JSON Schema to Zod conversion
- `AgentRunner` now calls `voice.setup()` before collecting tools (enables runtime tool discovery)
- Voice registry integration with `tuttiai/voices` on GitHub

### Published
- `@tuttiai/cli@0.7.0`
- `tutti-ai@0.8.0`
- `@tuttiai/mcp@0.1.0`

## [0.13.0] - 2026-04-12

### Added
- `stream()` method on the `LLMProvider` interface (`AsyncIterable<StreamChunk>`)
- `StreamChunk` type — `text`, `tool_use`, and `usage` chunk types
- Token-by-token streaming in `AnthropicProvider` (message stream events)
- Token-by-token streaming in `OpenAIProvider` (delta chunks with usage)
- Token-by-token streaming in `GeminiProvider` (content stream)
- `token:stream` event on `EventBus` for real-time token delivery
- `streaming` field on `AgentConfig` (default `false`)
- `AgentRunner.streamToResponse()` — consumes stream, emits events, builds `ChatResponse`
- Streaming REPL in `tutti-ai run` — spinner until first token, then live output
- Tool call display during streaming: `[using: name]` / `[done: name]`
- Graceful Ctrl+C during mid-stream responses

### Changed
- `tutti-ai run` enables `streaming: true` on all agents automatically
- Non-streaming fallback if no `token:stream` events received

### Published
- `@tuttiai/types@0.5.0`
- `@tuttiai/core@0.7.0`
- `@tuttiai/cli@0.6.0`
- `tutti-ai@0.7.0`

## [0.12.0] - 2026-04-12

### Added
- Structured logging with pino (`debug` / `info` / `warn` / `error` levels)
- `createLogger(name)` factory and default `logger` export
- `TUTTI_LOG_LEVEL` env var support (default: `info`)
- pino-pretty for colorized dev output, raw JSON in production
- OpenTelemetry tracing — `TuttiTracer` with `agentRun`, `llmCall`, `toolCall` spans
- `TelemetryConfig` on `ScoreConfig` (`enabled`, `endpoint?`, `headers?`)
- `initTelemetry()` / `shutdownTelemetry()` for OTel SDK lifecycle
- OTLP HTTP exporter with configurable endpoint (default `localhost:4318`)
- **Tutti Studio** — local web UI at `localhost:4747`
- `tutti-ai studio [score]` command with auto browser-open
- Studio: SVG agent graph (purple orchestrators, teal specialists, delegate arrows)
- Studio: live SSE event stream, color-coded by event type
- Studio: session browser with message history viewer
- Studio: token usage bar (input / output / estimated cost)
- Studio: REST API (`/api/score`, `/api/sessions`, `/api/run`)

### Changed
- All `console.log/warn/error` in core replaced with structured pino logging
- CLI error handlers and event traces migrated to structured logger
- Agent runner, providers, and runtime emit structured log context
- `.env.example` template now includes `TUTTI_LOG_LEVEL` and OTEL vars

### Published
- `@tuttiai/types@0.4.0`
- `@tuttiai/core@0.6.0`
- `@tuttiai/cli@0.5.0`
- `tutti-ai@0.6.0`

## [0.11.0] - 2026-04-11

### Added
- `PostgresSessionStore` — sessions persist to PostgreSQL across restarts
- `InMemorySemanticStore` — cross-session semantic (long-term) memory
- `SemanticMemoryStore` interface for custom memory backends
- `MemoryEntry` type for semantic memory records
- `memory.remember()` / `recall()` / `forget()` helpers on `ToolContext`
- `AgentMemoryConfig` — per-agent `semantic_memory` configuration
- `MemoryConfig` on `ScoreConfig` — `provider: 'in-memory' | 'postgres'`
- `TuttiRuntime.create()` async factory for database-backed stores
- `tutti-ai add postgres` with setup instructions
- `ToolMemoryHelpers` type for tool-level memory access

### Published
- `@tuttiai/types@0.3.0`
- `@tuttiai/core@0.5.0`
- `tutti-ai@0.5.0`

## [0.10.0] - 2026-04-11

### Added
- Unit test coverage 80%+ across all packages (96% lines on core)
- Integration test suite with 8 end-to-end scenarios
- `score-schema.test.ts` — 17 tests for Zod score validation
- `score-loader.test.ts` — 4 tests for dynamic score loading
- `security.test.ts` — 13 tests across all security layers
- `tutti-ai doctor` command (alias for `check`)
- v8 coverage thresholds: 80% lines, 80% functions, 70% branches
- `test:coverage` script in root package.json

### Improved
- All error messages now answer: what went wrong, where, and how to fix it
- Provider SDK errors caught and re-thrown with API key hints
- Filesystem voice errors include the path and remediation steps
- GitHub voice errors include owner/repo context
- Playwright voice errors include selector/URL context
- CLI REPL errors suggest running `tutti-ai check`
- Score loader errors include `export default defineScore(...)` example

### Published
- `@tuttiai/core@0.4.0`
- `@tuttiai/cli@0.4.0`
- `tutti-ai@0.4.0`

## [0.9.0] - 2026-04-11

### Added
- Comprehensive documentation site (22 MDX pages, Astro Starlight)
- Score file Zod validation in `ScoreLoader`
- Tool execution timeout (`tool_timeout_ms`, default 30s)
- `tutti-ai check` command for score validation without running
- Global `unhandledRejection` / `uncaughtException` handlers in CLI

## [0.8.0] - 2026-04-11

### Added
- `SecretsManager` for API key redaction and env var access
- `PermissionGuard` enforcing voice permission declarations
- `PathSanitizer` blocking system path access in filesystem voice
- `UrlSanitizer` blocking dangerous URL schemes in playwright voice
- `PromptGuard` detecting prompt injection in tool results
- `TokenBudget` with per-model pricing and budget enforcement
- Tool call rate limiting (`max_tool_calls`, default 20)
- Security test suite and GitHub Actions CI pipeline
- Pinned all external dependencies to exact versions
- `SECURITY.md` documenting all security layers

## [0.7.0] - 2026-04-11

### Added
- `OpenAIProvider` — LLMProvider for OpenAI/GPT models
- `GeminiProvider` — LLMProvider for Google Gemini models
- `tutti-ai add` command for installing voices
- Multi-agent delegation via `AgentRouter`

## [0.6.0] - 2026-04-10

### Added
- `@tuttiai/playwright` voice — 12 browser automation tools
- `@tuttiai/github` voice — 10 GitHub API tools
- `@tuttiai/filesystem` voice — 7 file system tools
- `TuttiRuntime`, `AgentRunner`, `EventBus`, `SessionStore`
- `defineScore()` typed configuration
- `tutti-ai init` and `tutti-ai run` CLI commands
