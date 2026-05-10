# @tuttiai/core

The runtime engine for [Tutti](https://tutti-ai.com) — an open-source multi-agent orchestration framework for TypeScript.

## Install

```bash
npm install @tuttiai/core
```

## Quick start

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";

const score = defineScore({
  name: "my-project",
  provider: new AnthropicProvider(), // uses ANTHROPIC_API_KEY env var
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a helpful assistant.",
      voices: [],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("assistant", "Hello!");
console.log(result.output);
```

## What's included

### Runtime & orchestration
- **TuttiRuntime** — top-level orchestrator
- **AgentRunner** — agentic while-loop (LLM call → tool execution → repeat)
- **AgentRouter** — delegation between orchestrator and specialist agents
- **TuttiGraph** — explicit directed-graph routing when you need more control than pure delegation
- **ScoreLoader** / **defineScore()** — typed loader + identity function for `tutti.score.ts`

### Providers
- **AnthropicProvider** — `@anthropic-ai/sdk`
- **OpenAIProvider** — `openai`
- **GeminiProvider** — `@google/generative-ai`
- All three support streaming, tool calling, and prompt caching where the underlying API supports it

### Sessions & memory
- **InMemorySessionStore**, **PostgresSessionStore** — session persistence
- **SemanticMemoryStore** — per-agent long-term memory (in-memory or Postgres). Two surfaces share one enforcement pipeline:
  - System-prompt injection — relevant entries injected at the start of each turn (`agent.memory.semantic.inject_system`).
  - Curated agent tools — `remember` / `recall` / `forget` exposed to the model itself (`agent.memory.semantic.curated_tools`, default `true`). Agent-curated entries are tagged `source: "agent"` and a per-agent cap evicts the least-recently-used entry on overflow. See [`examples/curated-memory.ts`](../../examples/curated-memory.ts).
- **UserMemoryStore** — per-end-user memory, auto-injected into the system prompt on every run (Postgres)

### Durability & scheduling
- **DurableCheckpointStore** — Redis / Postgres adapters; checkpoint between turns so crashed runs can resume with `tutti-ai resume`
- **SchedulerEngine** — cron / interval / one-shot triggers for any agent
- **InterruptStore** — per-tool approval gates for human-in-the-loop flows

### Observability
- **EventBus** — typed pub/sub for the full run lifecycle
- **getTuttiTracer()** — in-process OpenTelemetry-compatible span tracer (always on)
- **@tuttiai/telemetry** — exporters (OTLP, JSON file) + cost estimation

### Evaluation & guardrails
- **GoldenRunner** + built-in scorers (`ExactScorer`, `SimilarityScorer`, `ToolSequenceScorer`) for golden-dataset regression
- **beforeRun / afterRun** hooks for validation, PII redaction, topic blocking
- Built-in guardrail factories: `profanityFilter()`, `piiDetector()`, `topicBlocker()`

### Security
- **SecretsManager** — redaction of API keys and tokens from logs, events, and errors
- **PathSanitizer**, **UrlSanitizer** — defence against path traversal and SSRF
- **PromptGuard** — wraps tool results before returning them to the LLM
- **PermissionGuard** — enforces `Voice.required_permissions` at runtime

## Observability

Every action emits typed events:

```ts
tutti.events.on("tool:start", (e) => {
  console.log(`Calling tool: ${e.tool_name}`);
});
```

Spans for every run, LLM call, and tool invocation are also available via the built-in tracer:

```ts
import { getTuttiTracer } from "@tuttiai/telemetry";

const tracer = getTuttiTracer();
tracer.onSpan((span) => {
  console.log(span.kind, span.name, span.durationMs);
});
```

Or inspect them from the CLI while running `tutti-ai serve` in another shell:

```bash
tutti-ai traces list       # last 20 traces
tutti-ai traces show <id>  # full span tree
tutti-ai traces tail       # live-tail spans
```

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/core)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
