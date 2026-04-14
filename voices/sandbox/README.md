# @tuttiai/sandbox

Sandbox voice for [Tutti](https://tutti-ai.com) — secure code execution
for TypeScript, Python 3, and Bash.

## Install

```bash
npm install @tuttiai/sandbox
```

Requires `tsx` (for TypeScript) and `python3` (for Python) on the host.

## Usage

```typescript
import { SandboxVoice } from "@tuttiai/sandbox";

const score = defineScore({
  agents: {
    coder: {
      name: "coder",
      system_prompt: "You write and run code to solve problems.",
      voices: [new SandboxVoice({ timeout_ms: 10_000 })],
      permissions: ["shell"],
    },
  },
});
```

## Tools

### `run_code`

Execute a code snippet and return stdout, stderr, and exit code.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `code` | `string` | — | Source code to execute |
| `language` | `"typescript" \| "python" \| "bash"` | — | Target runtime |
| `timeout_ms` | `number` | `30000` | Wall-clock timeout (max 120 000) |

**Returns:** stdout, stderr, exit code, duration, and truncation status.

## Safety

- Processes run with `detached: false` and are killed on timeout via `SIGKILL`
- stdout and stderr truncated to 10 KB each
- ANSI escape codes stripped from all output
- Host filesystem paths redacted from error messages
- TypeScript runs via `tsx --no-cache` in a temp directory
- Python writes to a temp file (not `python3 -c`) for multi-line safety

## License

MIT
