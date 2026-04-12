# CLAUDE.md — Project Rules for Tutti

## Quick Reference

Before every change, verify:

- [ ] No `any` types — use `unknown` + type guards
- [ ] No `process.env` — use `SecretsManager.require()` / `.optional()`
- [ ] No API keys in logs, events, or error messages
- [ ] All tool results wrapped with `PromptGuard.wrap()`
- [ ] Dependency direction: types <- core <- cli, types <- voices, core <- voices
- [ ] New public methods have at least one unit test
- [ ] Conventional Commit message with package scope
- [ ] `npm audit --audit-level=high` passes
- [ ] CHANGELOG.md updated before tagging
- [ ] Voice `execute()` never throws — returns `{ content, is_error: true }`

---

## 1. Project Identity

Tutti is a multi-agent orchestration framework for TypeScript. The monorepo lives at `github.com/tuttiai/tutti`.

### Monorepo structure

```
packages/types/      @tuttiai/types      Type definitions (zero runtime deps)
packages/core/       @tuttiai/core       Runtime: AgentRunner, EventBus, providers, security
packages/cli/        @tuttiai/cli        CLI: init, run, check, studio, search, publish
packages/tutti-ai/   tutti-ai            Thin wrapper — re-exports CLI binary
voices/filesystem/   @tuttiai/filesystem 7 file system tools
voices/github/       @tuttiai/github     10 GitHub API tools
voices/playwright/   @tuttiai/playwright 12 browser automation tools
voices/mcp/          @tuttiai/mcp        MCP bridge — wraps any MCP server
```

### Terminology

| Term | Definition |
|------|-----------|
| **Voice** | A pluggable module that gives an agent tools and capabilities. Implements the `Voice` interface. |
| **Score** | The top-level config file (`tutti.score.ts`). Defines agents, provider, model, memory, telemetry. |
| **Agent** | A named LLM persona with a system prompt, model, and one or more voices. |
| **Tool** | A single function an agent can call. Defined with a Zod schema and an `execute()` handler. |
| **Repertoire** | The voice registry at `github.com/tuttiai/voices`. Searchable via `tutti-ai search`. |
| **Studio** | The local web UI served by `tutti-ai studio` at `localhost:4747`. |

---

## 2. TypeScript Standards

### Compiler strictness

- `strict: true` is enforced in `tsconfig.base.json` — never override it.
- `noUnusedLocals: true` and `noUnusedParameters: true` are enforced.
- Target is `ES2022`, module is `ES2022`, resolution is `bundler`.

### Type safety

- **No `any`**. Use `unknown` and narrow with type guards or Zod.
- **No non-null assertions (`!`)**. Use optional chaining (`?.`) or explicit checks.
- **No `as` casting** without a comment explaining why it is safe.
  ```typescript
  // Safe: MCP SDK returns untyped content blocks, and we validate via Array.isArray above.
  const blocks = result.content as { type: string; text?: string }[];
  ```
- **No enums**. Use `as const` objects:
  ```typescript
  const Permission = { NETWORK: "network", FILESYSTEM: "filesystem" } as const;
  type Permission = (typeof Permission)[keyof typeof Permission];
  ```
- Zod schemas are the single source of truth for runtime validation. Derive TypeScript types from them with `z.infer<>` when practical.

### Naming and files

- Files: `kebab-case.ts` (e.g., `agent-runner.ts`, `prompt-guard.ts`).
- Classes: `PascalCase` (e.g., `AgentRunner`, `PromptGuard`).
- No `I` prefix on interfaces. Write `Voice`, not `IVoice`.
- Tool names: `snake_case` (e.g., `read_file`, `search_issues`).

### Imports

- Always use `.js` extension for relative imports (ESM requirement):
  ```typescript
  import { logger } from "./logger.js";
  ```
- Use `import type` for type-only imports:
  ```typescript
  import type { AgentConfig, ChatResponse } from "@tuttiai/types";
  ```
- Group imports in this order, separated by blank lines:
  1. Node built-ins (`node:fs`, `node:path`)
  2. External packages (`zod`, `pino`, `@anthropic-ai/sdk`)
  3. Internal workspace packages (`@tuttiai/types`, `@tuttiai/core`)
  4. Relative imports (`./logger.js`, `../secrets.js`)

### Module exports

- No default exports from library packages (`types`, `core`, voices). Use named exports only.
- Each package has ONE public entry point: `src/index.ts`. All public API is exported from there.
- Internal modules are never imported from outside their package.

### Async patterns

- Never mix `async/await` with `.then()`/`.catch()`. Pick one per call site.
- Always use `try/finally` for cleanup of external resources (MCP clients, DB pools, child processes).

---

## 3. Architecture Rules

### Dependency direction

```
types  <--  core  <--  cli
  ^           ^
  |           |
  voices -----+
```

- `types` depends on nothing (only `zod` for schema types).
- `core` depends on `types`.
- `cli` depends on `core` and `types`.
- Voices depend on `types` (and optionally `core` for utilities).
- **Never** reverse the direction. **Never** create circular dependencies.

### Module boundaries

- Each package exposes its public API through `src/index.ts` only.
- Internal helpers (e.g., `src/secrets.ts`, `src/prompt-guard.ts`) are never imported from outside.
- All public exports must have TSDoc comments.

### Dependency injection

- Constructor injection for all dependencies. No singletons, no service locators.
  ```typescript
  // Correct:
  class AgentRunner {
    constructor(private provider: LLMProvider, private events: EventBus) {}
  }

  // Wrong: importing a global singleton
  import { globalProvider } from "./global.js";
  ```

### Error handling

- All errors must answer three questions: what went wrong, where, how to fix it.
  ```typescript
  throw new Error(
    `Agent "${name}" not found in your score.\n` +
    `Available agents: ${available}\n` +
    `Check your tutti.score.ts — the agent ID must match the key in the agents object.`,
  );
  ```
- Use custom error classes where callers need to distinguish error types: `PermissionError`, `BudgetExceededError`, `ScoreValidationError`.
- Voice `execute()` functions **never throw**. Return `{ content: "error description", is_error: true }`.

### State management

- All configuration flows through `ScoreConfig`. No global mutable state.
- All environment variables accessed via `SecretsManager` — never `process.env` directly.
- All observable state changes emitted as typed `EventBus` events.

---

## 4. Security Rules

Every rule in this section is enforced on every PR. Non-compliance blocks merge.

### Secrets

- 🔒 **Never** access `process.env` directly. Use `SecretsManager.require()` (throws if missing) or `SecretsManager.optional()`.
- 🔒 **Never** log, emit, or include API keys in error messages, event payloads, or tool results.
- 🔒 All `EventBus` payloads pass through `SecretsManager.redactObject()` before emission.
- 🔒 All error messages pass through `SecretsManager.redact()` before reaching the user.

### Input validation

- 🔒 All external input (user messages, tool results, API responses) validated with Zod before processing.
- 🔒 File paths run through `PathSanitizer` before every `fs` operation.
- 🔒 URLs run through `UrlSanitizer` before every network request.

### Permissions

- 🔒 Every `Voice` class **must** declare `required_permissions`.
- 🔒 The runtime **must** call `PermissionGuard.check()` before loading any voice.
- 🔒 All tool results wrapped with `PromptGuard.wrap()` before being added to messages.

### Dependencies

- 🔒 `npm audit --audit-level=high` must pass before publish.
- 🔒 Security-sensitive and LLM SDK dependencies (provider SDKs, `pg`, `express`, `@modelcontextprotocol/sdk`) pinned to exact versions — no `^` or `~`. Utility packages (`zod`, `chalk`, `pino`) may use `^` ranges. Rationale: provider SDK breaking changes have caused silent behavior regressions; pinning ensures reproducible builds for critical paths while allowing patch updates for low-risk utilities.
- 🔒 **Never** use `eval()` or `new Function()` with user-provided strings.

### Security checklist (verify before every PR)

- [ ] No `process.env` access outside SecretsManager
- [ ] No API keys in logs, events, or errors
- [ ] All external input validated with Zod
- [ ] File paths sanitized via PathSanitizer
- [ ] URLs sanitized via UrlSanitizer
- [ ] Tool results wrapped with PromptGuard.wrap()
- [ ] `npm audit --audit-level=high` passes
- [ ] No `eval()` or `new Function()` with dynamic input

---

## 5. Testing Rules

### Coverage thresholds (enforced in CI)

| Package | Lines | Functions | Branches |
|---------|-------|-----------|----------|
| `packages/core` | 85% | 85% | 75% |
| `packages/cli` | 70% | 70% | — |
| `voices/*` | 80% | 80% | — |

### File structure

```
tests/
  unit/              Unit tests for individual classes
  integration/       End-to-end pipeline tests
  security/          Proof-that-controls-work tests
  mocks/
    mock-provider.ts MockLLMProvider — always use this
```

### Test naming

```typescript
describe("AgentRunner", () => {
  it("stops when budget is exceeded", () => {
    // Arrange
    const provider = new MockLLMProvider([...]);

    // Act
    const result = await runner.run(agent, "hello");

    // Assert
    expect(result.turns).toBe(1);
  });
});
```

- `describe()` names the class or module.
- `it()` describes the behavior: "does X when Y".
- AAA pattern (Arrange/Act/Assert) with blank lines between sections.

### Hard rules

- ⚠ **Never** use real API keys in tests. Always use `MockLLMProvider`.
- ⚠ **Never** make real network calls in tests.
- ⚠ **Never** write to the real filesystem in tests. Use temp directories cleaned up in `afterEach`.
- Every new public method must include at least one unit test.
- Every bug fix needs a regression test that fails before the fix and passes after.
- Every security control needs a proof-it-works test (e.g., "redacts API key from error message").

---

## 6. Git & PR Conventions

### Commit messages

Conventional Commits format. Scope is the package name.

```
feat(core): add streaming support to AgentRunner
fix(cli): handle Ctrl+C during streaming response
security(core): redact API keys from EventBus payloads
perf(core): cache tool definitions across turns
refactor(types): extract StreamChunk from inline type
test(core): add regression test for budget overflow
docs(cli): add studio command to reference
chore(cli): bump express to 5.2.1
ci: add CodeQL analysis to PR workflow
```

Valid prefixes: `feat`, `fix`, `security`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`.

### Branches

- `feat/<description>` for features
- `fix/<description>` for bug fixes
- `security/<description>` for security patches

### Pull requests

- One feature or fix per PR.
- PR description must include: **what** changed, **why**, **how to test**, **breaking changes** (if any), **security implications** (if any).
- Squash merge for features. Merge commit for releases.

### Tags

- Always annotated: `git tag -a vX.Y.Z -m "..."`.
- Never tag a commit that doesn't pass CI.
- CHANGELOG.md updated **before** tagging, not after.

---

## 7. Voice Authoring Standards

### Required fields

Every Voice class must declare:

```typescript
export class MyVoice implements Voice {
  name = "my-voice";                           // kebab-case
  description = "One-line description";         // required
  required_permissions: Permission[] = ["network"]; // must be explicit
  tools = [myTool, otherTool];                  // at least one tool
}
```

### Tool definitions

- Tool names: `snake_case` (e.g., `read_file`, `create_issue`).
- Descriptions: 1-2 sentences. Specific. Explains when to use the tool.
- Every Zod field must have `.describe()`:
  ```typescript
  const parameters = z.object({
    path: z.string().describe("Absolute path to the file to read"),
    encoding: z.string().optional().describe("File encoding (default: utf-8)"),
  });
  ```
- Tool output is always a human-readable string, never raw JSON.
- **Never throw inside `execute()`**. Return `{ content: "error message", is_error: true }`.

### Voice README

Every voice must have a README.md with these sections:
1. Installation
2. Permissions required
3. Environment variables
4. Tools table (name, description, parameters)
5. Usage example
6. Security considerations

---

## 8. Performance Rules

- Tool results truncated at 8,000 characters (configurable via `AgentConfig.max_tool_result_chars`, default chosen to stay well within Claude's 200k context while leaving room for multi-turn conversation history) with a `[truncated]` notice appended.
- Session messages pruned when approaching the model's context window.
- `voice.setup()` called once per runtime — not per run. Guard with an `initialized` flag.
- Provider clients (Anthropic, OpenAI, Gemini) instantiated once in the constructor — not per request.
- `InMemorySessionStore` capped at 1,000 sessions (configurable via constructor `maxSessions` parameter) with LRU eviction. Default chosen to bound memory at ~50MB assuming ~50KB average session size. Use `PostgresSessionStore` for production workloads that need more.
- `EventBus.on()` returns an unsubscribe function. Always clean up listeners to prevent leaks.
- No circular references in event payloads — they must be JSON-serializable.

---

## 9. Documentation Rules

- TSDoc required on every exported class, interface, type, and function.
  ```typescript
  /**
   * Run an agent by name with the given user input.
   * Optionally pass a session_id to continue a conversation.
   */
  async run(agent_name: string, input: string, session_id?: string): Promise<AgentResult>
  ```
- New tool added to a voice: update the voice's MDX page and tool reference table.
- New CLI command: update `docs/cli/reference.mdx`.
- New config field on `ScoreConfig` or `AgentConfig`: update `docs/core-concepts.mdx`.
- Breaking change: update migration guide and CHANGELOG.md.
- All code examples in docs must be runnable. Test them before committing.
- Import paths in docs use published package names (`@tuttiai/core`), never relative paths.

---

## 10. Modularity & Extensibility

### Extension points (no changes to core required)

| Extension | How to add |
|-----------|-----------|
| New Voice | Implement `Voice` interface, publish to npm, register in Repertoire |
| New LLM Provider | Implement `LLMProvider` interface (`chat()` + `stream()`) |
| New Session Store | Implement `SessionStore` interface (`create`, `get`, `update`) |
| New Event Listener | Call `events.on()` or `events.onAny()` — pure addition |

### Stable interfaces (changes are breaking)

These interfaces are the public contract. Any change (adding required fields, removing fields, changing types) requires a **major** version bump:

- `Voice`, `Tool`, `ToolContext`, `ToolResult`, `VoiceContext`
- `LLMProvider`, `ChatRequest`, `ChatResponse`, `StreamChunk`
- `SessionStore`, `Session`

### Versioning rules

- Adding an **optional** field to an interface = non-breaking = **minor** bump.
- Any other interface change = breaking = **major** bump.
- New experimental features gated behind `ScoreConfig.experimental`.
- Features graduate from experimental when:
  - 80%+ test coverage
  - Used by 3+ community members
  - Documentation written
  - Security review completed
