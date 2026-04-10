<div align="center">
  <h1>Tutti</h1>
  <p><strong>All agents. All together.</strong></p>
  <p>Open-source multi-agent orchestration framework for TypeScript.</p>

  <p>
    <a href="https://tutti-ai.com">Website</a> ·
    <a href="https://tutti-ai.com/docs">Docs</a> ·
    <a href="https://tutti-ai.com/voices">Voice Registry</a> ·
    <a href="https://discord.gg/tuttiai">Discord</a>
  </p>

  <img src="https://img.shields.io/npm/v/@tuttiai/core?color=0F6E56&label=%40tuttiai%2Fcore" alt="npm" />
  <img src="https://img.shields.io/github/license/tuttiai/tutti?color=0F6E56" alt="license" />
  <img src="https://img.shields.io/github/stars/tuttiai/tutti?color=0F6E56" alt="stars" />
</div>

---

> **Tutti is under active development.** Star the repo to follow along.

## What is Tutti?

Tutti is a modular agent orchestration runtime for TypeScript. You compose
AI agents from reusable **Voices** — pluggable modules that give your agents
tools and connections — then wire them together in a typed **Score** file.

```ts
// tutti.score.ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { notionVoice } from "@tuttiai/voice-notion";
import { githubVoice } from "@tuttiai/voice-github";

export default defineScore({
  name: "my-project",
  provider: new AnthropicProvider(),
  agents: {
    researcher: {
      name: "researcher",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You research topics using Notion and GitHub.",
      voices: [notionVoice(), githubVoice()],
    },
  },
});
```

```ts
// run.ts
import { TuttiRuntime, ScoreLoader } from "@tuttiai/core";

const score = await ScoreLoader.load("./tutti.score.ts");
const tutti = new TuttiRuntime(score);

const result = await tutti.run("researcher", "Summarize our open issues");
console.log(result.output);
```

## Core Concepts

| Concept         | Tutti Term       | Description                                   |
| --------------- | ---------------- | --------------------------------------------- |
| Plugin / module | **Voice**        | Gives an agent tools (e.g. `voice-notion`)    |
| Configuration   | **Score**        | `tutti.score.ts` — typed config, not YAML     |
| Agent team      | **Section**      | A group of agents that collaborate             |
| Plugin registry | **Repertoire**   | Community voice registry at tutti-ai.com       |
| Contributor     | **Composer**     | You                                           |

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  tutti.score.ts                   │
│            (defineScore — typed config)           │
├──────────────────────────────────────────────────┤
│                  TuttiRuntime                     │
│  ┌────────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ AgentRunner│  │ EventBus │  │ SessionStore │ │
│  │  (loop)    │  │ (pub/sub)│  │ (in-memory)  │ │
│  └─────┬──────┘  └──────────┘  └──────────────┘ │
│        │                                         │
│  ┌─────▼──────────────────────────────────────┐  │
│  │            LLMProvider (generic)           │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  AnthropicProvider (@anthropic-ai/sdk)│  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
│        │                                         │
│  ┌─────▼──────────────────────────────────────┐  │
│  │              Voices (plugins)              │  │
│  │  ┌────────┐ ┌────────┐ ┌──────────────┐   │  │
│  │  │ Notion │ │ GitHub │ │ Playwright   │   │  │
│  │  └────────┘ └────────┘ └──────────────┘   │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### How the Agent Loop Works

1. User sends a message to a named agent
2. `AgentRunner` appends the message to the session and calls the LLM
3. If the LLM returns `tool_use` blocks, the runner executes each tool
   (Zod-validated), appends results, and loops back to step 2
4. When the LLM returns `end_turn`, the final text is returned
5. Every step emits events on the `EventBus` for full observability

## Packages

| Package                              | Description                          |
| ------------------------------------ | ------------------------------------ |
| [`@tuttiai/types`](packages/types)   | All interfaces and type definitions  |
| [`@tuttiai/core`](packages/core)     | Runtime, agent loop, providers       |
| [`@tuttiai/cli`](packages/cli)       | CLI binary (`tutti-ai`)              |

## Getting Started

### Quick Start with the CLI

```bash
npx @tuttiai/cli init my-project
cd my-project
cp .env.example .env       # add your ANTHROPIC_API_KEY
npm install
npx tutti-ai run
```

### Install as a Library

```bash
npm install @tuttiai/core
```

### Programmatic Usage

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";

const score = defineScore({
  name: "hello-tutti",
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

### Building a Voice

A Voice is a plugin that gives an agent tools:

```ts
import { z } from "zod";
import type { Voice } from "@tuttiai/types";

export function myVoice(): Voice {
  return {
    name: "my-voice",
    description: "Does something useful",
    tools: [
      {
        name: "greet",
        description: "Greets someone by name",
        parameters: z.object({ name: z.string() }),
        execute: async (input) => ({
          content: `Hello, ${input.name}!`,
        }),
      },
    ],
  };
}
```

### Observability

Every action in the runtime emits typed events:

```ts
const tutti = new TuttiRuntime(score);

tutti.events.on("llm:response", (e) => {
  console.log(`[${e.agent_name}] tokens: ${e.response.usage.input_tokens}in / ${e.response.usage.output_tokens}out`);
});

tutti.events.on("tool:start", (e) => {
  console.log(`[${e.agent_name}] calling tool: ${e.tool_name}`);
});

// or subscribe to everything
tutti.events.onAny((e) => console.log(e.type, e));
```

## Testing

Tutti has comprehensive test coverage across all packages. Tests are written
with [vitest](https://vitest.dev/) and run in parallel via Turborepo.

```bash
npm test                   # run all tests
npm test -- --filter=core  # run only core tests
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details on writing tests.

## Security

We take security seriously. See [SECURITY.md](./SECURITY.md) for:

- How to report vulnerabilities (privately)
- API key handling practices
- Tool input validation (Zod)
- Score file trust model

## Roadmap

- [x] Core runtime (`TuttiRuntime`, `AgentRunner`)
- [x] Type system (`@tuttiai/types`)
- [x] Anthropic provider
- [x] EventBus observability
- [x] `defineScore()` typed config
- [x] CLI (`tutti-ai init`, `tutti-ai run`)
- [x] Test suite (52+ tests across core and CLI)
- [ ] Voice interface spec & validation
- [ ] First-party voices (Notion, GitHub, Playwright, Slack)
- [ ] Multi-agent sections (agent-to-agent orchestration)
- [ ] Streaming responses
- [ ] Persistent session stores (SQLite, Redis)
- [ ] Voice registry (the Repertoire)
- [ ] Docs site

## Contributing

Tutti is built for contributors. Every voice you add makes the whole
orchestra richer.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, architecture
details, and pull request guidelines.

## License

MIT &copy; [Tutti AI](https://tutti-ai.com)
