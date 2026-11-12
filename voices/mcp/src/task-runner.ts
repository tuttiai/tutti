import type { Client } from "@modelcontextprotocol/sdk/client";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Task, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { ResponseMessage } from "@modelcontextprotocol/sdk/experimental/tasks";
import type { ToolResult } from "@tuttiai/types";

/** How long the voice waits for the server to confirm a cancel, in ms. */
export const CANCEL_TIMEOUT_MS = 5000;

/** Longest server status message the voice copies into a result. */
const STATUS_MESSAGE_MAX = 500;

const ABORTED = Symbol("aborted");

/** One progress update from a running MCP task. */
export interface TaskProgress {
  /** The server's task id, once the task exists. */
  task_id?: string;
  /** The task's status, for example `working`. */
  status?: string;
  /** Work done so far, from a progress notification. */
  progress?: number;
  /** Total amount of work, when the server knows it. */
  total?: number;
  /** The server's status message. */
  message?: string;
}

/** The tool call to run as a task. */
export interface TaskCall {
  /** The voice name, which names the server in messages. */
  server: string;
  /** The MCP tool's name. */
  name: string;
  /** The validated arguments. */
  args: Record<string, unknown>;
}

/** Options for {@link runToolTask}. */
export interface TaskRunOptions {
  /** Aborting it stops waiting and cancels the task. */
  signal?: AbortSignal;
  /** Called on every status change and progress notification until the call ends. */
  onProgress?: (update: TaskProgress) => void;
  /** How long to wait for the server to confirm a cancel. Defaults to {@link CANCEL_TIMEOUT_MS}. */
  cancelTimeoutMs?: number;
}

interface RunState {
  call: TaskCall;
  taskId?: string;
  statusMessage?: string;
  ended: boolean;
  onProgress?: (update: TaskProgress) => void;
}

/**
 * Call a tool as an MCP task: create it, poll it with the SDK's loop, and
 * return its result in the same shape as a plain `callTool`. When `signal`
 * aborts, stop waiting at once and send `tasks/cancel` once, best effort.
 * Never throws: every failure is a result with `is_error: true` and a hint.
 *
 * @param client - A connected MCP client.
 * @param call - The server, tool and arguments.
 * @param options - The abort signal, progress callback and cancel timeout.
 * @returns The tool result.
 */
export async function runToolTask(client: Client, call: TaskCall, options: TaskRunOptions = {}): Promise<ToolResult> {
  const state: RunState = { call, ended: false, onProgress: options.onProgress };
  if (options.signal?.aborted === true) return cancelled(state, abortReason(options.signal));
  const stream = client.experimental.tasks.callToolStream(
    { name: call.name, arguments: call.args },
    CallToolResultSchema,
    { signal: options.signal, onprogress: (p) => report(state, { progress: p.progress, total: p.total, message: p.message }) },
  );
  const outcome = await raceAbort(consume(stream, state), options.signal);
  state.ended = true;
  if (outcome !== ABORTED) return outcome;
  const note = await cancelTask(client, state.taskId, options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS);
  return cancelled(state, abortReason(options.signal), note);
}

async function consume(stream: AsyncIterable<ResponseMessage<CallToolResult>>, state: RunState): Promise<ToolResult> {
  try {
    for await (const message of stream) {
      const result = handle(message, state);
      if (result) return result;
    }
    return failed(state, "the stream ended without a result");
  } catch (error) {
    return failed(state, errorText(error));
  }
}

function handle(message: ResponseMessage<CallToolResult>, state: RunState): ToolResult | undefined {
  switch (message.type) {
    case "taskCreated":
    case "taskStatus":
      noteTask(state, message.task);
      return undefined;
    case "result":
      return mapResult(message.result);
    case "error":
      return failed(state, message.error.message);
  }
}

function noteTask(state: RunState, task: Task): void {
  state.taskId = task.taskId;
  if (task.statusMessage !== undefined) state.statusMessage = task.statusMessage.slice(0, STATUS_MESSAGE_MAX);
  report(state, { status: task.status, message: task.statusMessage });
}

function report(state: RunState, update: TaskProgress): void {
  if (state.ended || !state.onProgress) return;
  state.onProgress({ task_id: state.taskId, ...update });
}

/** The same mapping as the plain path: text blocks joined, `isError` kept. */
function mapResult(result: CallToolResult): ToolResult {
  const text = result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return { content: text || "(no output)", is_error: result.isError === true };
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return work;
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(resolve).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function cancelTask(client: Client, taskId: string | undefined, timeout: number): Promise<string | undefined> {
  if (taskId === undefined) return "the server had not created the task yet";
  try {
    await client.experimental.tasks.cancelTask(taskId, { timeout });
    return undefined;
  } catch (error) {
    return `the server did not confirm the cancel (${errorText(error)})`;
  }
}

function label(state: RunState): string {
  const { name, server } = state.call;
  return state.taskId === undefined ? `MCP tool ${name} on ${server}` : `MCP task ${state.taskId} (${name} on ${server})`;
}

function failed(state: RunState, detail: string): ToolResult {
  const reason = state.statusMessage === undefined ? detail : `${state.statusMessage} (${detail})`;
  return {
    content: `${label(state)} failed: ${reason}. Check the input and the server's logs, then retry.`,
    is_error: true,
  };
}

function cancelled(state: RunState, reason: string, note?: string): ToolResult {
  const extra = note === undefined ? "" : ` Note: ${note}.`;
  return {
    content: `${label(state)} cancelled (${reason}).${extra} Retry with a smaller input or raise tool_timeout_ms.`,
    is_error: true,
  };
}

/** A runtime timeout aborts with a `TuttiError` whose code is `TOOL_TIMEOUT`. */
function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  const timedOut = typeof reason === "object" && reason !== null && "code" in reason && reason.code === "TOOL_TIMEOUT";
  return timedOut ? "timed out" : "run aborted";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
