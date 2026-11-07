import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a tool's `execute` can learn about the call it runs in, beyond its
 * `ToolContext`. Internal to `@tuttiai/core`: not exported from the index.
 */
export interface ToolCallScope {
  /** Id of the tool_use block being executed. */
  tool_call_id: string;
  /** Session of the run that made the call. */
  session_id: string;
  /** The run's signal, when the caller gave one. */
  signal?: AbortSignal;
}

/**
 * Carries a {@link ToolCallScope} from `AgentRunner.executeTool` into the
 * tool it runs, so `delegate_to_agent` can tag streamed output and pass the
 * run's signal on without a new field on the public `ToolContext`.
 */
export const toolCallScope = new AsyncLocalStorage<ToolCallScope>();

/**
 * Build the scope for one tool call, leaving `signal` out when there is none.
 *
 * @param tool_call_id - Id of the tool_use block.
 * @param session_id - Session of the run that made the call.
 * @param signal - The run's signal, if it has one.
 * @returns The scope to run the tool's `execute` in.
 */
export function scopeFor(
  tool_call_id: string,
  session_id: string,
  signal: AbortSignal | undefined,
): ToolCallScope {
  return signal ? { tool_call_id, session_id, signal } : { tool_call_id, session_id };
}
