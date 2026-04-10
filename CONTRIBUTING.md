# Contributing to Tutti

Welcome, Composer. Every voice you add makes the orchestra richer.

## Ways to Contribute

- **Build a Voice** — add a new integration to the Repertoire
- **Improve the core** — help build the runtime, providers, and agent loop
- **Write docs** — make Tutti easier to understand
- **Report bugs** — open an issue with a clear reproduction

## Development Setup

### Prerequisites

- Node.js >= 20
- npm >= 10

### Clone and Install

```bash
git clone https://github.com/tuttiai/tutti.git
cd tutti
npm install
```

### Build

```bash
npm run build        # builds all packages via Turborepo
```

### Typecheck

```bash
npm run typecheck    # strict TypeScript check across all packages
```

### Test

```bash
npm test                         # run all tests across all packages
npm test -- --filter=core        # run only @tuttiai/core tests
npm test -- --filter=cli         # run only @tuttiai/cli tests
cd packages/core && npx vitest   # watch mode for core
```

## Project Structure

```
tutti/
├── packages/
│   ├── types/              # @tuttiai/types — interfaces & type definitions
│   │   └── src/
│   │       ├── llm.ts      #   LLMProvider, ChatRequest/Response, ContentBlock
│   │       ├── voice.ts    #   Voice, Tool<T>, ToolResult
│   │       ├── agent.ts    #   AgentConfig, AgentResult
│   │       ├── score.ts    #   ScoreConfig
│   │       ├── session.ts  #   Session, SessionStore
│   │       ├── events.ts   #   TuttiEvent discriminated union
│   │       └── index.ts    #   barrel re-exports
│   │
│   ├── core/               # @tuttiai/core — the runtime engine
│   │   └── src/
│   │       ├── runtime.ts          # TuttiRuntime — top-level orchestrator
│   │       ├── agent-runner.ts     # AgentRunner — agentic while-loop
│   │       ├── event-bus.ts        # EventBus — typed pub/sub
│   │       ├── session-store.ts    # InMemorySessionStore
│   │       ├── score-loader.ts     # Dynamic import of tutti.score.ts
│   │       ├── define-score.ts     # defineScore() identity helper
│   │       ├── providers/
│   │       │   └── anthropic.ts    # AnthropicProvider (LLMProvider impl)
│   │       └── index.ts            # barrel re-exports
│   │
│   └── cli/                # @tuttiai/cli — the tutti-ai binary
│       └── src/
│           ├── index.ts            # CLI entry point (commander.js)
│           └── commands/
│               ├── init.ts         # tutti-ai init [project-name]
│               └── run.ts          # tutti-ai run [score]
│
├── examples/               # Runnable example scripts
│   └── basic.ts            # Minimal TuttiRuntime proof-of-concept
├── voices/                 # Community voice packages (future)
├── turbo.json              # Turborepo pipeline config
├── tsconfig.base.json      # Shared strict TypeScript config
└── package.json            # Workspace root
```

## Tech Stack

| Tool         | Purpose                        |
| ------------ | ------------------------------ |
| TypeScript   | Strict mode throughout         |
| Turborepo    | Monorepo build orchestration   |
| npm          | Workspaces & package manager   |
| tsup         | Bundling (ESM + .d.ts)         |
| vitest       | Testing                        |
| Zod          | Runtime schema validation      |

## Key Design Decisions

- **Score files are TypeScript** (`tutti.score.ts`), not JSON or YAML — you get
  full type checking, autocomplete, and the ability to instantiate providers
  and voices inline.

- **`defineScore()` is a typed identity function** — it returns exactly what you
  pass in. No hidden transforms, no magic. It exists solely for type inference.

- **`LLMProvider` is model-agnostic** — `AnthropicProvider` is the first
  implementation, but the interface is designed to support any provider
  (OpenAI, local models, etc.).

- **`Tool` parameters use Zod schemas** — validated at runtime before execution,
  and converted to JSON Schema for the LLM via `zod-to-json-schema`.

- **EventBus for observability** — every lifecycle event (agent start/end, LLM
  request/response, tool start/end/error, turn start/end) is emitted so you
  can build logging, tracing, and monitoring on top.

## Adding a New Provider

Implement the `LLMProvider` interface from `@tuttiai/types`:

```ts
import type { LLMProvider, ChatRequest, ChatResponse } from "@tuttiai/types";

export class MyProvider implements LLMProvider {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Map request to your provider's API format
    // Map response back to ChatResponse
  }
}
```

## Writing Tests

We use [vitest](https://vitest.dev/) for all tests. Tests live alongside
source files with a `.test.ts` suffix.

### Conventions

- **Mock the LLM provider** — never make real API calls in tests. Create a
  mock `LLMProvider` that returns canned `ChatResponse` objects.
- **Use real Zod schemas** — test that tool input validation works with
  actual Zod schemas, not mocks.
- **Test event emission** — subscribe to the `EventBus` and assert the
  correct event sequence is emitted.
- **CLI tests use temp directories** — the init command tests create
  isolated temp directories and mock `process.cwd()` to avoid side effects.

### Test structure

```
packages/core/src/
├── event-bus.ts
├── event-bus.test.ts        # ← tests next to source
├── session-store.ts
├── session-store.test.ts
├── agent-runner.ts
├── agent-runner.test.ts
├── runtime.ts
├── runtime.test.ts
├── define-score.ts
└── define-score.test.ts

packages/cli/src/commands/
├── init.ts
├── init.test.ts
├── run.ts
└── run.test.ts              # ← future
```

### Running a single test file

```bash
cd packages/core
npx vitest run src/event-bus.test.ts
```

## Security

See [SECURITY.md](./SECURITY.md) for our security policy. Key points
for contributors:

- Never commit API keys or secrets
- All tool inputs must be Zod-validated before execution
- Score files are dynamically imported — treat them like executable code
- Run `npm audit` before submitting dependency changes

## Pull Request Guidelines

- One feature or fix per PR
- **Add tests for new functionality** — PRs without tests for new code
  will be asked to add them
- Run `npm run build && npm run typecheck && npm test` before submitting
- Update docs if behavior changes
- Keep commit messages descriptive: `feat:`, `fix:`, `chore:`, `docs:`
- Be kind — we're all composers here
