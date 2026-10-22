# @tuttiai/sandbox

Sandbox voice for [Tutti](https://tutti-ai.com) — secure code execution
with per-session filesystem isolation for TypeScript, Python 3, and Bash,
and a ranked map of any repository cloned into the sandbox.

## Install

```bash
npm install @tuttiai/sandbox
```

Requires `tsx` (for TypeScript) and `python3` (for Python) on the host.

## Quick start

```typescript
import { SandboxVoice } from "@tuttiai/sandbox";
import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";

const score = defineScore({
  name: "coding-agent",
  provider: new AnthropicProvider(),
  agents: {
    coder: {
      name: "coder",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a coding assistant. Write code to solve problems, " +
        "execute it to verify, and iterate until correct. You can " +
        "write files, install packages, and run code in the sandbox.",
      voices: [
        new SandboxVoice({
          allowed_languages: ["typescript", "python"],
          allowed_packages: ["lodash", "zod", "chalk"],
          timeout_ms: 15_000,
          max_file_size_bytes: 512_000,
        }),
      ],
      permissions: ["shell"],
    },
  },
});

const runtime = new TuttiRuntime(score);
const result = await runtime.run(
  "coder",
  "Write a TypeScript function that computes the first N Fibonacci numbers, " +
  "test it, and show me the output for N=15.",
);
console.log(result.output);
```

## Configuration

```typescript
new SandboxVoice(config?: SandboxConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowed_languages` | `Language[]` | all three | Restrict `execute_code` to specific runtimes |
| `allowed_packages` | `string[]` | all | Allowlist for `install_package` |
| `timeout_ms` | `number` | `30000` | Default execution timeout |
| `max_file_size_bytes` | `number` | `1048576` (1 MB) | Max file size for `write_file` |
| `env` | `Record<string, string>` | — | Extra env vars for child processes. They inherit only `PATH`, `HOME`, user, shell, locale, `TZ`, `TMPDIR`, `TERM`, proxy and CA variables from the agent, so pass anything else here |
| `install_timeout_ms` | `number` | `60000` | Timeout for package installs |

## Tools

### `repo_map`

**Call this first when working in a repository.** Returns a ranked map of the
files that matter most and, under each, the one-line signatures of its key
functions, classes, types and methods with their line numbers, within a token
budget. Then read only the line ranges you need with `read_file`'s
`start_line` and `end_line`, instead of whole files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `string` | sandbox root | Directory to map, such as the folder a repository was cloned into |
| `focus` | `string[]` | — | File paths (relative to `path`) and/or identifiers the task is about; the map centres on them |
| `max_tokens` | `number` | `1500` | Size of the map, at most 6000 (estimated at 4 characters a token) |

```text
src/core/widget-registry.ts
  1: export interface WidgetDefinition {
  5: export function registerWidget(definition: WidgetDefinition): void {
  9: export function lookupWidget(widgetName: string): WidgetDefinition | undefined {
src/features/alpha.ts
  4: export function alphaFeature(): WidgetDefinition | undefined {
[4 files and 4 definitions left out. Pass focus (file paths or names) or a larger max_tokens to see others.]
```

How it works, after [Aider's repo map](https://aider.chat/2023/10/22/repomap.html):

1. Files come from `git ls-files` (tracked and untracked, honouring `.gitignore`) in a
   git work tree, otherwise from a bounded walk. Dependency, build, cache and vendored
   directories, generated and minified files, lock files, binaries, symbolic links and
   files over 200 KB are skipped. At most 5,000 files are read.
2. Each file is tagged with its definitions and the identifiers it uses: with
   tree-sitter (WebAssembly, no native build) for TypeScript, TSX, JavaScript, Python,
   Go and PHP, and with line patterns for Swift and Kotlin, or for any file a grammar
   cannot read.
3. Files are linked by the names they share, an edge from A to B for each name A uses
   that B defines, weighted up for long camelCase or snake_case names and focused names
   and down for short, common, private-looking or many-times-defined ones.
4. Files are ranked by personalised PageRank (damping 0.85), centred on the focused
   files and the files defining focused names. Each definition scores its file's rank
   times the weight of the edges reaching it, and the most that fit the budget are shown.

Parsed tags are cached in `.tutti-cache/repo-map/` inside the sandbox, keyed by path,
modification time and size, so a second call on an unchanged repository reads no file.
The directory carries a `*` `.gitignore`, so it never shows in `git status`. After 20
seconds the map is rendered from the files read so far and says so.

### `execute_code`

Execute a code snippet and return stdout, stderr, and exit code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `code` | `string` | — | Source code to execute |
| `language` | `"typescript" \| "python" \| "bash"` | — | Runtime (filtered by `allowed_languages`) |
| `timeout_ms` | `number` | `30000` | Wall-clock timeout (max 120 000) |

### `write_file`

Write a file to the sandbox directory.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `string` | — | Path relative to sandbox root |
| `content` | `string` | — | File content |

Creates parent directories as needed. Rejects files exceeding `max_file_size_bytes`.

### `read_file`

Read a file from the sandbox directory.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `string` | — | Path relative to sandbox root |
| `encoding` | `"utf-8" \| "base64"` | `"utf-8"` | File encoding |
| `start_line` | `number` | — | First line to return, 1-based (utf-8 only) |
| `end_line` | `number` | end of file | Last line to return, inclusive (utf-8 only) |

With a line range, the result opens with `[lines a-b of N]`. Without one, the
whole file is returned as before.

### `install_package`

Install a package into the sandbox.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | — | Package name (e.g. `lodash`, `numpy`) |
| `manager` | `"npm" \| "pip"` | `"npm"` | Package manager |

Returns `{ package, version, duration_ms }`. Rejects names not on the `allowed_packages` list when configured.

## Lifecycle

The sandbox is created per session via the Voice lifecycle:

1. **`setup(context)`** — creates `/tmp/tutti-sandbox/{session_id}/` and builds all tools.
2. Tools run with the sandbox directory as their working directory.
3. **`teardown()`** — deletes the entire sandbox directory tree.

Required permission: `"shell"` (must be explicitly granted in `AgentConfig.permissions`).

## Safety

| Measure | Detail |
|---------|--------|
| Filesystem isolation | Every path validated by `SessionSandbox.resolve()` — throws `SandboxEscapeError` for `../../` traversal |
| Repository map | `repo_map` refuses a directory whose real path leaves the sandbox, skips symbolic links, and stops git searching above the sandbox for a repository |
| Process timeout | `SIGKILL` after `timeout_ms`; exit code 137 |
| Output size | stdout/stderr truncated to 10 KB each |
| ANSI codes | Stripped from all output |
| Path leaks | Host temp path replaced with `<workdir>` |
| File size | `write_file` rejects content exceeding `max_file_size_bytes` |
| Package allowlist | `install_package` rejects names not on `allowed_packages` |
| Shell injection | Package names validated against `[a-zA-Z0-9@_./-]` regex |
| Language restriction | `execute_code` Zod schema rejects disallowed languages |

## License

Apache 2.0
