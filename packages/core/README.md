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

- **TuttiRuntime** — top-level orchestrator
- **AgentRunner** — agentic while-loop (LLM call → tool execution → repeat)
- **AnthropicProvider** — `LLMProvider` implementation via `@anthropic-ai/sdk`
- **EventBus** — typed pub/sub for full lifecycle observability
- **InMemorySessionStore** — conversation persistence
- **ScoreLoader** — dynamic import of `tutti.score.ts` files
- **defineScore()** — typed identity function for score authoring

## Observability

Every action emits typed events:

```ts
tutti.events.on("tool:start", (e) => {
  console.log(`Calling tool: ${e.tool_name}`);
});
```

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/core)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
