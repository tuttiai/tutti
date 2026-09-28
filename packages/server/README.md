# @tuttiai/server

HTTP server for [Tutti](https://tutti-ai.com) — expose your multi-agent score as a REST API with SSE streaming, bearer-token auth, rate limiting, and CORS.

## Install

```bash
npm install @tuttiai/server
```

Peer dependencies: `@tuttiai/core` and `@tuttiai/types`.

## Quick start

```typescript
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { createServer } from "@tuttiai/server";

const score = defineScore({
  name: "my-api",
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a helpful assistant.",
      voices: [],
    },
  },
});

const runtime = new TuttiRuntime(score);
const app = await createServer({
  port: 3847,
  host: "0.0.0.0",
  runtime,
  agent_name: "assistant",
});

await app.listen({ port: 3847, host: "0.0.0.0" });
```

Or use the CLI:

```bash
tutti-ai serve --port 3847 --watch
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/run` | Run agent to completion. Returns `{ output, session_id, turns, usage, cost_usd, duration_ms }`. |
| `POST` | `/run/stream` | SSE stream: `turn_start`, `tool_call`, `approval_requested`, `tool_result`, `content_delta`, `turn_end`, `run_complete`, or `error`. |
| `GET` | `/sessions/:id` | Retrieve session conversation history. |
| `GET` | `/health` | `{ status: "ok", version, uptime_s }`. |

## Configuration

```typescript
interface ServerConfig {
  port: number;                          // Default: 3847
  host: string;                          // Default: "127.0.0.1"
  runtime: TuttiRuntime;                 // Pre-built runtime
  agent_name: string;                    // Agent key in the score
  api_key?: string;                      // Falls back to TUTTI_API_KEY env
  rate_limit?: { max: number; timeWindow: string } | false;
  cors_origins?: string | string[];      // Falls back to TUTTI_ALLOWED_ORIGINS env
  timeout_ms?: number;                   // Default: 120_000
  stream_heartbeat_ms?: number;          // Default: 15_000; 0 turns it off
}
```

### Approvals on `/run/stream`

When a tool call needs a person's approval (see `requireApproval` on the agent; tools marked
`destructive: true` are gated by default) and the runtime has an `InterruptStore`, the run pauses
and the stream says so:

```
data: {"event":"approval_requested","interrupt_id":"...","session_id":"...","tool_name":"create_pull_request","tool_args":{...}}
```

The stream stays open. `POST /interrupts/:id/approve` resumes the run on the same stream, so
`tool_result` and `run_complete` follow. `POST /interrupts/:id/deny` ends the run, and the stream
closes with an `error` frame whose `message` carries the denial reason.

A paused run writes nothing, and undici's `fetch` aborts a response body after 300 seconds without
a chunk. So `/run/stream` writes an SSE comment, `: heartbeat`, every `stream_heartbeat_ms` for as
long as the stream is open. SSE clients discard comments; a hand-written parser should skip any
line starting with `:`.

## Middleware

Registered in order: request ID → CORS → rate limit → bearer auth → global error handler → routes.

- **Request ID**: `x-request-id` header on every response (echoes client ID or generates UUID).
- **CORS**: `@fastify/cors` with `Authorization` + `Content-Type` allowed headers.
- **Rate limit**: `@fastify/rate-limit` at 60 req/min per API key by default.
- **Auth**: constant-time bearer-token comparison; `/health` is public.
- **Error handler**: maps `TuttiError` subtypes to HTTP status codes; hides stack traces in production.

## Docker

```bash
docker build -t tutti-server .
docker run -p 3847:3847 -e TUTTI_API_KEY=key -e ANTHROPIC_API_KEY=sk-... tutti-server
```

See the repo root `docker-compose.yml` for a full stack with Postgres and Redis.

`TUTTI_PROVIDER=claude-code` answers through the Claude Code CLI and its own login instead of an
API key. The stock image does not carry the CLI; build one that does with
`--build-arg CLAUDE_CODE_VERSION=<exact version>`, and pass `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token` rather than `ANTHROPIC_API_KEY`. It is for your own agents on your own
machine; see the providers guide.

The image runs one agent configured entirely by environment:

| Variable | Default | Meaning |
|---|---|---|
| `TUTTI_AGENT_NAME` | `assistant` | The agent's key |
| `TUTTI_SYSTEM_PROMPT` | `You are a helpful assistant.` | Its system prompt |
| `TUTTI_PROVIDER`, `TUTTI_MODEL` | `anthropic`, a Sonnet model | Provider (`anthropic`, `openai`, `gemini` or `claude-code`) and model |
| `TUTTI_VOICES` | none | JSON array of `{ "voice", "options", "only"? }` |
| `TUTTI_PERMISSIONS` | none | Comma-separated: `network`, `filesystem`, `shell`, `browser` |
| `TUTTI_MAX_TURNS`, `TUTTI_MAX_TOOL_CALLS` | runtime defaults | Loop limits |
| `TUTTI_MAX_COST_USD` | none | Hard cost ceiling per run |
| `TUTTI_REQUIRE_APPROVAL` | `destructive` | Which tool calls wait for a person, below |

The image carries four voices: `github`, `slack`, `email` and `web`. Each entry's `options` is
validated by that voice's own `.strict()` config schema, credentials included, and `only` keeps
just the named tools. Every voice needs the permissions it declares, so all four need
`TUTTI_PERMISSIONS=network`. Any refusal (an unknown voice, an unknown option or tool, a missing
permission) stops the process before it listens, and no refusal ever quotes an option's value.

```bash
docker run -p 3847:3847 -e TUTTI_API_KEY=key -e ANTHROPIC_API_KEY=sk-... \
  -e TUTTI_PERMISSIONS=network \
  -e TUTTI_VOICES='[{"voice":"github","options":{"token":"ghp_..."},"only":["list_issues","get_issue"]}]' \
  tutti-server
```

The image's runtime always carries an in-memory interrupt store, so a gated tool call pauses
for a person instead of failing the run. `TUTTI_REQUIRE_APPROVAL` says which calls are gated:

| Value | Gated |
|---|---|
| unset, empty or `destructive` | Tools marked `destructive: true`, such as GitHub's `create_pull_request` |
| `none` | Nothing, destructive tools included |
| `all` | Every tool call |
| `send_*, create_issue` | The named tools, plus destructive ones |

A list is comma-separated, and each item is a tool name or glob of letters, digits and
`_ * . -`; anything else stops the start. Only `*` is a wildcard, and `?` is refused because the
matcher would read it as a literal.
Approve or deny with `POST /interrupts/:id/approve` or `/deny`, taking the id from the
`approval_requested` frame on `/run/stream` or from `GET /sessions/:id/interrupts`. Pending
approvals live in memory, so a restart forgets them along with the runs waiting on them.

```bash
docker run -p 3847:3847 -e TUTTI_API_KEY=key -e ANTHROPIC_API_KEY=sk-... \
  -e TUTTI_PERMISSIONS=network -e TUTTI_REQUIRE_APPROVAL='create_issue' \
  -e TUTTI_VOICES='[{"voice":"github","options":{"token":"ghp_..."}}]' \
  tutti-server
```

`docker inspect` shows every variable, credentials in `TUTTI_VOICES` included. Anyone who can
inspect containers on the host can read them.

## License

Apache 2.0
