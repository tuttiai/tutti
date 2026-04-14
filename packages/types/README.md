# @tuttiai/types

Type definitions for the [Tutti](https://tutti-ai.com) multi-agent orchestration framework.

## Install

```bash
npm install @tuttiai/types
```

## What's included

All core interfaces for building on Tutti:

- **LLM** — `LLMProvider`, `ChatRequest`, `ChatResponse`, `ContentBlock`, `ChatMessage`
- **Voice** — `Voice`, `Tool<T>`, `ToolResult`, `ToolContext`
- **Agent** — `AgentConfig`, `AgentResult`
- **Score** — `ScoreConfig`
- **Session** — `Session`, `SessionStore`
- **Events** — `TuttiEvent`, `TuttiEventType`, `TuttiEventHandler`

## Usage

```ts
import type { Voice, Tool, LLMProvider } from "@tuttiai/types";
```

Most users should install `@tuttiai/core` instead — it re-exports all types from this package along with the runtime implementation.

## Links

- [Tutti](https://tutti-ai.com)
- [GitHub](https://github.com/tuttiai/tutti/tree/main/packages/types)
- [Docs](https://tutti-ai.com/docs)

## License

Apache 2.0
