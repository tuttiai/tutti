import type { AgentResult, ScoreConfig, ToolResult } from "@tuttiai/types";

import { RunAbortedError } from "../errors.js";
import { throwIfAborted } from "../run-abort.js";
import type { TuttiRuntime } from "../runtime.js";
import type { DelegateInput } from "./delegate-tool.js";
import { delegateChain, extendChain, wouldCycle } from "./delegate-chain.js";
import { forwardDeltas } from "./delta-forwarder.js";
import { toolCallScope, type ToolCallScope } from "./tool-call-scope.js";

/** What a `delegate_to_agent` tool needs from the router that built it. */
export interface DelegateDeps {
  /** The runtime that runs the specialists (read lazily). */
  runtime: () => TuttiRuntime;
  /** The score, to look specialists up by id. */
  score: ScoreConfig;
  /** Id of the agent that owns the tool. */
  callerId: string;
  /** Name sent as `from` on delegation events. */
  callerName: string;
}

/**
 * Run one `delegate_to_agent` call: emit `delegate:start`, run the
 * specialist while forwarding its streamed output as `delegate:delta`, then
 * emit `delegate:end` on success. Failures come back as an error result, as
 * before; an aborted run's {@link RunAbortedError} is re-thrown so the
 * parent run stops instead of asking the model what to do next.
 *
 * @param deps - The router's runtime, score and caller.
 * @param input - The validated tool input.
 * @returns The specialist's output, or an error result with a fix hint.
 * @throws {RunAbortedError} When the parent run's signal aborts.
 */
export async function runDelegate(deps: DelegateDeps, input: DelegateInput): Promise<ToolResult> {
  if (wouldCycle(deps.callerId, input.agent_id)) return cycleResult(input.agent_id);
  const events = deps.runtime().events;
  events.emit({ type: "delegate:start", from: deps.callerName, to: input.agent_id, task: input.task });
  try {
    const result = await runSpecialist(deps, input, toolCallScope.getStore());
    events.emit({ type: "delegate:end", from: deps.callerName, to: input.agent_id, output: result.output });
    return { content: result.output || "(specialist returned no output)" };
  } catch (error) {
    if (error instanceof RunAbortedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Delegation to "${input.agent_id}" failed: ${message}`, is_error: true };
  }
}

/**
 * Run the specialist. Inside a runner's tool call it gets its own session up
 * front, the parent's signal and the delegation chain, and its tokens are
 * forwarded until it settles. Called outside one, it runs as it always has.
 *
 * @throws {RunAbortedError} When the parent run's signal aborts.
 */
async function runSpecialist(
  deps: DelegateDeps,
  input: DelegateInput,
  call: ToolCallScope | undefined,
): Promise<AgentResult> {
  const runtime = deps.runtime();
  if (!call) return runtime.run(input.agent_id, input.task);
  const name = new Map(Object.entries(deps.score.agents)).get(input.agent_id)?.name ?? input.agent_id;
  const session = runtime.sessions.create(name);
  const chain = extendChain(call, deps.callerId, input.agent_id);
  const detach = forwardDeltas(runtime.events, {
    parent_session_id: call.session_id,
    root_session_id: chain.root_session_id,
    tool_call_id: call.tool_call_id,
    from: deps.callerName,
    to: input.agent_id,
    session_id: session.id,
    path: chain.path,
    ...(call.signal ? { signal: call.signal } : {}),
  });
  const options = call.signal ? { signal: call.signal } : undefined;
  try {
    const result = await delegateChain.run(chain, () => runtime.run(input.agent_id, input.task, session.id, options));
    // A specialist that finished after the abort still ends without delegate:end.
    throwIfAborted(call.signal);
    return result;
  } finally {
    detach();
  }
}

function cycleResult(agentId: string): ToolResult {
  return {
    content:
      `Delegation to "${agentId}" refused: it is already running further up this delegation chain, ` +
      `so it would loop. Answer from what you have, or delegate to a different specialist.`,
    is_error: true,
  };
}
