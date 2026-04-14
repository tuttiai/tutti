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
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        }),
      ],
      permissions: ["network"],
    },
  },
});
```

The voice spawns the MCP server as a child process on `setup()`, discovers
its tools via `tools/list`, and exposes them as Tutti tools. On `teardown()`,
the server process is stopped.

## License

Apache 2.0
