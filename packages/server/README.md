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
| `POST` | `/run/stream` | SSE stream: `turn_start`, `tool_call`, `tool_result`, `content_delta`, `turn_end`, `run_complete`. |
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
}
```

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

## License

MIT
