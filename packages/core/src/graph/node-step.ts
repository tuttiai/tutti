/**
 * Running one graph node: its agent call, the `node:*` events around it,
 * and folding its result into the run cursor.
 */

import type { AgentConfig, TokenUsage } from "@tuttiai/types";
import type { GraphConfig, GraphNode, NodeResult } from "./types.js";
import { GraphCycleError, GraphStateError } from "./errors.js";
import { addUsage } from "../usage.js";
import type { RunContext, RunCursor } from "./run-context.js";

/** @internal The input a node runs on: its user message and the state it sees. */
export interface NodeStep {
  input: string;
  state: Record<string, unknown>;
}

/** @internal A node run that finished, with its token usage and wall-clock time. */
export interface NodeRun {
  nodeResult: NodeResult;
  usage: TokenUsage;
  duration_ms: number;
}

/** @internal A node that ran, with its result. */
export interface BranchDone {
  id: string;
  result: NodeResult;
}

/**
 * The node's agent. If the graph has a state schema and the current state
 * is non-empty, the state snapshot is appended to the agent's system
 * prompt so the LLM can read it.
 */
function agentFor(ctx: RunContext, node: GraphNode, state: Record<string, unknown>): AgentConfig {
  if (!ctx.hasStateSchema || Object.keys(state).length === 0) return node.agent;
  return {
    ...node.agent,
    system_prompt:
      node.agent.system_prompt + "\n\nCurrent graph state:\n" + JSON.stringify(state),
  };
}

/** Run a single graph node by executing its agent and collecting the result. */
async function runNode(
  ctx: RunContext,
  node: GraphNode,
  step: NodeStep,
): Promise<{ nodeResult: NodeResult; usage: TokenUsage }> {
  const start = Date.now();
  const result = await ctx.runner.run(agentFor(ctx, node, step.state), step.input);
  const nodeResult: NodeResult = {
    output: result.output,
    structured: result.structured,
    metadata: {
      duration_ms: Date.now() - start,
      turns: result.turns,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  };
  return { nodeResult, usage: result.usage };
}

/**
 * @internal Emit `node:start`, run the node, and emit `node:error` before re-throwing
 * so observers see the failure and run() callers still get the exception.
 */
export async function runObserved(ctx: RunContext, node: GraphNode, step: NodeStep): Promise<NodeRun> {
  ctx.emit({ type: "node:start", node_id: node.id, input: step.input });
  const startedAt = Date.now();
  try {
    const r = await runNode(ctx, node, step);
    return { ...r, duration_ms: Date.now() - startedAt };
  } catch (err) {
    ctx.emit({
      type: "node:error",
      node_id: node.id,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  }
}

/**
 * Attempt to shallow-merge a `state_update` from a node's structured
 * output into the shared state. Re-validates via the Zod schema when
 * one is defined.
 *
 * @returns The updated state, or the original state if no update was found.
 */
function applyStateUpdate(
  config: GraphConfig,
  state: Record<string, unknown>,
  done: BranchDone,
): Record<string, unknown> {
  const structured: unknown = done.result.structured;
  if (typeof structured !== "object" || structured === null) return state;
  if (!("state_update" in structured)) return state;
  const update: unknown = structured.state_update;
  if (typeof update !== "object" || update === null) return state;
  const merged = { ...state, ...update };
  if (!config.state) return merged;
  try {
    // The state schema describes the graph's shared state object (see
    // GraphConfig.state), so its parsed output is that record.
    return config.state.parse(merged) as Record<string, unknown>;
  } catch (err) {
    throw new GraphStateError(done.id, err instanceof Error ? err.message : String(err));
  }
}

/** @internal Fold a finished node into the cursor and emit `state:update` and `node:end`. */
export function recordNode(ctx: RunContext, cursor: RunCursor, step: { id: string; run: NodeRun }): void {
  const { id, run } = step;
  addUsage(cursor.usage, run.usage);
  cursor.outputs.set(id, run.nodeResult);
  cursor.path.push(id);
  const nextState = applyStateUpdate(ctx.config, cursor.state, { id, result: run.nodeResult });
  if (nextState !== cursor.state) {
    cursor.state = nextState;
    ctx.emit({ type: "state:update", node_id: id, state: { ...cursor.state } });
  }
  ctx.emit({ type: "node:end", node_id: id, result: run.nodeResult, duration_ms: run.duration_ms });
}

/** @internal Loop guard: count a visit and throw past the cap. Returns the visit number. */
export function countVisit(ctx: RunContext, cursor: RunCursor, nodeId: string): number {
  const count = (cursor.visits.get(nodeId) ?? 0) + 1;
  cursor.visits.set(nodeId, count);
  if (count > ctx.maxVisits) {
    throw new GraphCycleError(nodeId, count, ctx.maxVisits);
  }
  return count;
}
