# Changelog

## [Unreleased]

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
