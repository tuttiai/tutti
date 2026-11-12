import type { ToolResult } from "@tuttiai/types";

/**
 * How the voice calls one MCP tool: as an MCP task, through plain
 * `callTool`, or not at all because the tool needs tasks the server lacks.
 */
export type TaskMode = "task" | "plain" | "unsupported";

/** The part of an MCP server's capabilities that says it runs tool calls as tasks. */
export interface TaskCapabilities {
  tasks?: { requests?: { tools?: { call?: object } } };
}

/**
 * Decide how to call a tool. Tasks are used only when the tool's
 * `execution.taskSupport` is `optional` or `required` and the server
 * declares `tasks.requests.tools.call`; every other tool stays on `callTool`.
 *
 * @param caps - The server's capabilities from the initialize handshake.
 * @param taskSupport - The tool's `execution.taskSupport` from `tools/list`.
 * @returns The call mode.
 */
export function taskMode(caps: TaskCapabilities | undefined, taskSupport: string | undefined): TaskMode {
  const serverRunsTasks = caps?.tasks?.requests?.tools?.call !== undefined;
  if (taskSupport === "required") return serverRunsTasks ? "task" : "unsupported";
  if (taskSupport === "optional" && serverRunsTasks) return "task";
  return "plain";
}

/**
 * The result for a tool that requires MCP Tasks on a server that does not
 * declare them. Returned before any request is sent.
 *
 * @param server - The voice name, which names the server.
 * @param tool - The tool's name.
 * @returns An error result with a fix hint.
 */
export function unsupportedResult(server: string, tool: string): ToolResult {
  return {
    content:
      `MCP tool ${tool} requires MCP Tasks, but server ${server} does not declare them. ` +
      "Upgrade the server, or use a tool that does not require tasks.",
    is_error: true,
  };
}
