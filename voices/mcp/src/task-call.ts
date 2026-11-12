import type { Client } from "@modelcontextprotocol/sdk/client";
import type { ToolContext, ToolResult } from "@tuttiai/types";
import { runToolTask, type TaskCall, type TaskProgress } from "./task-runner.js";
import { unsupportedResult, type TaskMode } from "./task-support.js";

/**
 * The tool context with the two optional fields newer runtimes provide:
 * the call's abort signal and its progress reporter. On older runtimes both
 * are absent, and tasks still run, without cancel or progress.
 */
export type TaskAwareContext = ToolContext & {
  signal?: AbortSignal;
  report_progress?: (update: TaskProgress & { source?: string }) => void;
};

/**
 * Call a tool whose mode is not `plain`: refuse a tool that needs tasks the
 * server lacks, or run it as a task, wiring the context's signal and
 * progress reporter in. Never throws.
 *
 * @param client - The connected client, or undefined once torn down.
 * @param call - The server, tool, arguments and the mode from `taskMode`.
 * @param context - The context the runtime passed to `execute`.
 * @returns The tool result.
 */
export async function callWithTask(
  client: Client | undefined,
  call: TaskCall & { mode: Exclude<TaskMode, "plain"> },
  context: TaskAwareContext,
): Promise<ToolResult> {
  if (!client) return { content: "MCP client not connected", is_error: true };
  if (call.mode === "unsupported") return unsupportedResult(call.server, call.name);
  const report = context.report_progress;
  return runToolTask(client, call, {
    signal: context.signal,
    onProgress: report ? (update): void => report({ ...update, source: call.server }) : undefined,
  });
}
