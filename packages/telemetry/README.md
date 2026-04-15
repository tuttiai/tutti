# @tuttiai/telemetry

In-process span tracing, cost estimation, and OTLP/JSON export for [Tutti](https://tutti-ai.com).

Wired into `@tuttiai/core` automatically — every agent run, LLM call, tool call, guardrail, and checkpoint becomes a span. No application-code changes required.

## Install

```bash
npm install @tuttiai/telemetry
```

`@tuttiai/core` already depends on this package, so most users never install it directly. Reach for it when you want to:

- subscribe to live span events from your application code
- write a custom exporter (Slack alerts, Postgres archive, …)
- inspect or aggregate traces in tests

## Quick start

The runtime auto-exports spans when you set one of these in your score:

```ts
import { defineScore } from "@tuttiai/core";

export default defineScore({
  // …agents, provider…
  telemetry: {
    enabled: false, // OTel SDK auto-instrumentation (separate)

    // Pick one — OTLP/HTTP collector:
    otlp: {
      endpoint: "http://localhost:4318/v1/traces",
      headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY ?? "" },
    },

    // …or newline-delimited JSON file (great for CI eval artefacts):
    jsonFile: "./traces.jsonl",
  },
});
```

Or via environment variable, no score change needed:

```bash
TUTTI_OTLP_ENDPOINT=http://localhost:4318/v1/traces npm run dev
TUTTI_TRACE_FILE=./traces.jsonl npm run dev
```

Env vars beat the score config so operators can override without editing source.

## Inspect spans in code

Every run returns a `trace_id` you can use to retrieve the full span tree:

```ts
import { getTuttiTracer } from "@tuttiai/telemetry";

const result = await tutti.run("assistant", "Hi!");
const spans = getTuttiTracer().getTrace(result.trace_id!);
// → [agent.run, llm.completion, tool.call, ...]
```

Subscribe for live tailing:

```ts
const stop = getTuttiTracer().subscribe((span) => {
  console.log(`${span.name} ${span.status} ${span.duration_ms}ms`);
});
// stop() to detach
```

## Cost estimation

Built-in price table for the major model families. `cost_usd` is recorded on every `llm.completion` span and aggregated onto `result.usage.cost_usd`:

```ts
import { estimateCost, getRunCost, registerModelPrice } from "@tuttiai/telemetry";

estimateCost("gpt-4o", 1000, 500);              // → 0.0125

registerModelPrice("our-fine-tune", 100, 200);  // USD per 1M tokens
estimateCost("our-fine-tune", 1000, 500);       // → 0.2

const cost = getRunCost(result.trace_id!);
// → { prompt_tokens, completion_tokens, total_tokens, cost_usd }
```

Built-in models (USD per 1M tokens):

| Model | Input | Output |
|---|---|---|
| `gpt-4o` | $5 | $15 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `claude-opus-4` | $15 | $75 |
| `claude-sonnet-4` | $3 | $15 |
| `claude-haiku-3-5` | $0.80 | $4 |
| `gemini-2-0-flash` | $0.10 | $0.40 |

Returns `null` for unregistered models so callers can detect missing pricing instead of silently zeroing out.

## Exporters

```ts
import {
  configureExporter,
  JsonFileExporter,
  OTLPExporter,
} from "@tuttiai/telemetry";

const stop = configureExporter(
  new OTLPExporter({
    endpoint: "http://localhost:4318/v1/traces",
    headers: { "x-api-key": "…" },
  }),
);

// later, before exit:
await stop();
```

- **`OTLPExporter`** — buffered (100 spans / 5 s), retries 3× with 1s/2s/4s backoff on network errors and 5xx; 4xx is permanent. Uses `JsonTraceSerializer` from `@opentelemetry/otlp-transformer`. Compatible with Jaeger, Datadog, Honeycomb, Grafana Tempo, and any OTLP/HTTP collector.
- **`JsonFileExporter`** — appends one JSON object per closed span to a file. Lazy file-open on first write.
- **Custom** — implement the `SpanExporter` interface (`export` / `flush` / `shutdown`).

## Span schema

Every span carries:

```ts
interface TuttiSpan {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  kind: "agent" | "tool" | "llm" | "guardrail" | "checkpoint";
  started_at: Date;
  ended_at?: Date;
  duration_ms?: number;
  status: "running" | "ok" | "error";
  attributes: TuttiSpanAttributes; // typed bag — see types.ts
  error?: { message: string; stack?: string };
}
```

The runtime emits these span names automatically:

| Name | Kind | Key attributes |
|---|---|---|
| `agent.run` | `agent` | `agent_id`, `session_id`, `model` |
| `llm.completion` | `llm` | `model`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost_usd` |
| `tool.call` | `tool` | `tool_name`, `tool_input`, `tool_output` |
| `guardrail` | `guardrail` | `guardrail_name`, `guardrail_action` (`pass`/`redact`/`block`) |
| `checkpoint` | `checkpoint` | `session_id` |

## CLI

The `tutti-ai traces` commands in `@tuttiai/cli` consume these spans through the `@tuttiai/server` REST + SSE endpoints:

```bash
tutti-ai traces list           # last 20 traces
tutti-ai traces show <id>      # full span tree
tutti-ai traces tail           # live SSE tail
```

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/telemetry)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
