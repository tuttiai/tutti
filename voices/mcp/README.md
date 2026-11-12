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

## Long-running tools (MCP Tasks)

Some MCP servers run slow tools (builds, crawls, data jobs) as
[tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
instead of holding one request open. The voice uses a task when both of these hold:

- the server declares `tasks.requests.tools.call` in its capabilities, and
- the tool's `execution.taskSupport` in `tools/list` is `optional` or `required`.

It then creates the task, polls it at the interval the server asks for, and
returns the result in the same shape as a plain call. A task that fails
returns `is_error: true` with the server's status message. A tool marked
`required` on a server without the capability returns `is_error: true` with a
fix hint, and nothing is sent.

On runtimes that provide them (`@tuttiai/core` with `ToolContext.signal` and
`report_progress`):

- **Progress.** Each status change and progress notification becomes a
  `tool:progress` event with `task_id`, `status`, `progress`, `total`,
  `message` and `source` (the voice name, which names the server).
- **Cancel.** When the run is aborted or the call passes `tool_timeout_ms`,
  the voice stops waiting at once and sends `tasks/cancel` once, waiting up to
  5 seconds for the server to confirm it. The agent gets `is_error: true`
  naming the task, the tool and the server, with "cancelled (run aborted)" or
  "cancelled (timed out)". A server may ignore or reject the cancel; the result
  then says so.

On older runtimes tasks still run and return their results, without
progress or cancel. Every other tool, and every tool on a server without
tasks, is called exactly as before through `callTool`.

## License

Apache 2.0
