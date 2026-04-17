# @tuttiai/types

Type definitions for the [Tutti](https://tutti-ai.com) multi-agent orchestration framework.

## Install

```bash
npm install @tuttiai/types
```

## What's included

All core interfaces for building on Tutti — zero runtime dependencies, zod only:

- **LLM** — `LLMProvider`, `ChatRequest`, `ChatResponse`, `StreamChunk`, `ContentBlock` (`TextBlock` / `ToolUseBlock` / `ToolResultBlock`), `ChatMessage`, `StopReason`, `ToolDefinition`, `TokenUsage`
- **Voice** — `Voice`, `Tool<T>`, `ToolResult`, `ToolContext`, `VoiceContext`, `Permission`, `ToolMemoryHelpers`, `UserMemoryToolHelpers`
- **Agent** — `AgentConfig`, `AgentResult`, `ParallelAgentResult`, `BudgetConfig`, `AgentMemoryConfig`, `AgentUserMemoryConfig`, `AgentCacheConfig`, `AgentDurableConfig`, `AgentScheduleConfig`, `GuardrailHook`, `RunContext`
- **Score** — `ScoreConfig`, `MemoryConfig`, `TelemetryConfig`, `ParallelEntryConfig`
- **Session** — `Session`, `SessionStore`
- **Events** — `TuttiEvent`, `TuttiEventType`, `TuttiEventHandler`
- **Hooks** — `HookContext`, `TuttiHooks` (Claude Code–style hook system)

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
