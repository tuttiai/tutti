# Changelog

## [0.14.0] - 2026-04-12

### Added
- `tutti-ai search <query>` — search the voice registry by name, description, or tags
- `tutti-ai voices` — list all official voices with install status
- `tutti-ai publish` — automated voice publishing (pre-flight checks, npm publish, registry PR)
- `tutti-ai publish --dry-run` — validate without publishing
- `tuttiai-mcp` voice — MCP bridge wraps any MCP server as a Tutti voice
- `McpVoice` with stdio transport, dynamic tool discovery, and JSON Schema to Zod conversion
- `AgentRunner` now calls `voice.setup()` before collecting tools (enables runtime tool discovery)
- Voice registry integration with `tuttiai/voices` on GitHub

### Published
- `@tuttiai/cli@0.7.0`
- `tutti-ai@0.8.0`
- `tuttiai-mcp@0.1.0`

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
