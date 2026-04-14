# Changelog

## [Unreleased]

### Added — `@tuttiai/web@0.1.0` (web search voice)
- New `voices/web` package — gives agents web search via `web_search` tool.
- Three provider backends: Brave Search API (`BRAVE_SEARCH_API_KEY`), Serper.dev (`SERPER_API_KEY`), DuckDuckGo Instant Answer API (free, no key, limited results).
- Auto-selection factory: picks the highest-priority provider whose env var is set (Brave > Serper > DuckDuckGo).
- All providers normalise to `SearchResult[]` (`{ title, url, snippet, published_date? }`), handle HTTP errors gracefully (empty array + warn log), and respect configurable `timeout_ms` (default 5000).
- 23 unit tests covering all three providers, the factory, the tool, and the voice class.

## @tuttiai/server@0.1.0 · @tuttiai/cli@0.11.0

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
