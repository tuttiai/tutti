<div align="center">
  <h1>Tutti</h1>
  <p><strong>All agents. All together.</strong></p>
  <p>Open-source multi-agent orchestration framework for TypeScript.</p>

  <p>
    <a href="https://tutti-ai.com">Website</a> ·
    <a href="https://docs.tutti-ai.com">Docs</a> ·
    <a href="https://github.com/tuttiai/tutti/issues">Issues</a> ·
    <a href="https://discord.gg/tuttiai">Discord</a>
  </p>

  <img src="https://img.shields.io/npm/v/@tuttiai/core?color=0F6E56&label=%40tuttiai%2Fcore" alt="npm" />
  <img src="https://img.shields.io/github/license/tuttiai/tutti?color=0F6E56" alt="license" />
  <img src="https://img.shields.io/github/stars/tuttiai/tutti?color=0F6E56" alt="stars" />
</div>

---

## What is Tutti?

Tutti is a multi-agent orchestration runtime for TypeScript. You compose AI agents from **Voices** (pluggable tool packages), wire them together in a typed **Score** file, and let them work together.

```ts
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { FilesystemVoice } from "@tuttiai/filesystem";
import { GitHubVoice } from "@tuttiai/github";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    coder: {
      name: "Coder",
      model: "claude-sonnet-4-20250514",
      system_prompt: "You are a senior TypeScript developer.",
      voices: [new FilesystemVoice(), new GitHubVoice()],
      permissions: ["filesystem", "network"],
    },
  },
});

const tutti = new TuttiRuntime(score);
const result = await tutti.run("coder", "Fix the bug in src/index.ts");
console.log(result.output);
```

## Quick Start

```bash
npx tutti-ai init my-project
cd my-project
cp .env.example .env       # add your ANTHROPIC_API_KEY
npm install
npx tutti-ai run
```

## Packages

| Package | Version | Description |
| ------- | ------- | ----------- |
| [`@tuttiai/types`](packages/types) | 0.3.0 | Type definitions and interfaces |
| [`@tuttiai/core`](packages/core) | 0.5.0 | Runtime, providers, security, memory |
| [`@tuttiai/cli`](packages/cli) | 0.4.0 | CLI (`tutti-ai init`, `run`, `add`, `check`, `doctor`) |
| [`@tuttiai/filesystem`](voices/filesystem) | 0.1.0 | 7 file tools (read, write, search, etc.) |
| [`@tuttiai/github`](voices/github) | 0.1.0 | 10 GitHub tools (issues, PRs, repos, code search) |
| [`@tuttiai/playwright`](voices/playwright) | 0.1.0 | 12 browser tools (navigate, click, type, screenshot) |

## Features

### Multi-Agent Orchestration

An orchestrator agent delegates to specialists via `AgentRouter`:

```ts
import { AgentRouter, defineScore } from "@tuttiai/core";

const score = defineScore({
  provider: new AnthropicProvider(),
  entry: "orchestrator",
  agents: {
    orchestrator: {
      name: "Orchestrator",
      role: "orchestrator",
      system_prompt: "Route tasks to the right specialist.",
      voices: [],
      delegates: ["coder", "qa"],
    },
    coder: { /* ... */ },
    qa: { /* ... */ },
  },
});

const router = new AgentRouter(score);
const result = await router.run("Write and test a reverse function");
```

### Three LLM Providers

```ts
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from "@tuttiai/core";

new AnthropicProvider()          // ANTHROPIC_API_KEY
new OpenAIProvider()             // OPENAI_API_KEY
new GeminiProvider()             // GEMINI_API_KEY
```

### Persistent Sessions (PostgreSQL)

```ts
const score = defineScore({
  provider: new AnthropicProvider(),
  memory: { provider: "postgres" },  // uses DATABASE_URL
  agents: { /* ... */ },
});

const tutti = await TuttiRuntime.create(score);  // async init for DB
```

### Semantic (Long-Term) Memory

Agents remember facts across sessions:

```ts
{
  coder: {
    name: "Coder",
    system_prompt: "You are a TypeScript developer.",
    semantic_memory: { enabled: true, max_memories: 5 },
    voices: [new FilesystemVoice()],
    permissions: ["filesystem"],
  },
}
```

Tools can explicitly store memories:

```ts
execute: async (input, context) => {
  await context.memory?.remember("User prefers 2-space indentation");
  const prefs = await context.memory?.recall("code style");
  return { content: "Noted your preferences." };
}
```

### Security

- **Permission system** — voices declare requirements, agents grant explicitly
- **Secret redaction** — API keys scrubbed from events and error messages
- **Prompt injection defense** — tool results scanned and wrapped with safety markers
- **Path traversal protection** — system paths blocked in filesystem voice
- **URL sanitization** — `file:`, `javascript:`, private IPs blocked in browser voice
- **Token budgets** — per-agent limits on tokens and cost
- **Tool rate limiting** — max calls per run + per-tool timeout
- **Score validation** — Zod-validated on load

### Observability

Every step emits typed events:

```ts
tutti.events.on("tool:start", (e) => console.log(`Using: ${e.tool_name}`));
tutti.events.on("budget:warning", (e) => console.log(`Budget: ${e.tokens} tokens`));
tutti.events.on("security:injection_detected", (e) => console.warn(`Injection in: ${e.tool_name}`));
```

## CLI

```bash
tutti-ai init [project]     # Scaffold a new project
tutti-ai run [score]        # Run a score interactively
tutti-ai add <voice>        # Install a voice (filesystem, github, playwright, postgres)
tutti-ai check [score]      # Validate a score without running it
tutti-ai doctor [score]     # Alias for check
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   tutti.score.ts                      │
│             (defineScore — typed config)              │
├──────────────────────────────────────────────────────┤
│                   TuttiRuntime                        │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ AgentRunner│  │ EventBus │  │  SessionStore     │ │
│  │  (loop)    │  │ (pub/sub)│  │  (memory/postgres)│ │
│  └─────┬──────┘  └──────────┘  └──────────────────┘ │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │           LLMProvider (swappable)              │  │
│  │  Anthropic  ·  OpenAI  ·  Gemini              │  │
│  └────────────────────────────────────────────────┘  │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │              Voices (plugins)                  │  │
│  │  Filesystem · GitHub · Playwright · yours      │  │
│  └────────────────────────────────────────────────┘  │
│        │                                             │
│  ┌─────▼──────────────────────────────────────────┐  │
│  │              Security Layer                    │  │
│  │  Permissions · Secrets · PromptGuard · Budget  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Testing

217 tests across 18 files. 96% line coverage on core.

```bash
npx vitest run              # all tests
npm run test:coverage       # with v8 coverage
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [contributing docs](https://docs.tutti-ai.com/contributing/overview/).

```bash
git clone https://github.com/tuttiai/tutti.git
cd tutti && npm install && npm run build
npx vitest run
```

## Security

See [SECURITY.md](./SECURITY.md). Report vulnerabilities to security@tutti-ai.com.

## License

MIT &copy; [Tutti AI](https://tutti-ai.com)
