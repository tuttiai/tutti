# @tuttiai/sandbox

Sandbox voice for [Tutti](https://tutti-ai.com) — secure code execution
with per-session filesystem isolation for TypeScript, Python 3, and Bash.

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
| `env` | `Record<string, string>` | — | Extra env vars for child processes |
| `install_timeout_ms` | `number` | `60000` | Timeout for package installs |

## Tools

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
| Process timeout | `SIGKILL` after `timeout_ms`; exit code 137 |
| Output size | stdout/stderr truncated to 10 KB each |
| ANSI codes | Stripped from all output |
| Path leaks | Host temp path replaced with `<workdir>` |
| File size | `write_file` rejects content exceeding `max_file_size_bytes` |
| Package allowlist | `install_package` rejects names not on `allowed_packages` |
| Shell injection | Package names validated against `[a-zA-Z0-9@_./-]` regex |
| Language restriction | `execute_code` Zod schema rejects disallowed languages |

## License

MIT
