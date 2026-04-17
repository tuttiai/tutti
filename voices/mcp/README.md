# @tuttiai/mcp

MCP bridge voice for [Tutti](https://tutti-ai.com) — wraps any
[Model Context Protocol](https://modelcontextprotocol.io) server as a
Tutti voice, exposing its tools to your agents.

## Install

```bash
npm install @tuttiai/mcp
```

## Usage

```typescript
import { McpVoice } from "@tuttiai/mcp";

const score = defineScore({
  agents: {
    assistant: {
      name: "assistant",
      voices: [
        new McpVoice({
          // Full shell command for the MCP server — split on whitespace
          server: "npx -y @modelcontextprotocol/server-filesystem /tmp",
        }),
      ],
      permissions: ["network"],
    },
  },
});
```

### Options

| Field | Type | Description |
| ----- | ---- | ----------- |
| `server` | `string` (required) | Shell command that launches the MCP server. Split on whitespace — the first token is the executable, the rest are arguments. |
| `args` | `string[]` | Additional CLI arguments appended after the server command. |
| `env` | `Record<string, string>` | Extra environment variables passed to the server child process. |
| `name` | `string` | Override the voice name (default: `mcp-<server-name>`). |

The voice spawns the MCP server as a child process on `setup()`, discovers
its tools via `tools/list`, and exposes them as Tutti tools. On `teardown()`,
the server process is stopped.

## License

Apache 2.0
