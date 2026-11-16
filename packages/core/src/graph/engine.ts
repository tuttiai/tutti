/**
 * Graph execution engine — walks the node/edge graph, running each
 * node's agent through an {@link AgentRunner} and following edges
 * according to the algorithm in DESIGN.md.
 */

import type { AgentRunner } from "../agent-runner.js";
import type {
  GraphConfig,
  GraphEdge,
  GraphEvent,
  GraphRunResult,
  NodeResult,
  RunOptions,
} from "./types.js";
import { END } from "./types.js";
import { logger } from "../logger.js";
import {
  buildResult,
  createRunContext,
  startCursor,
  type RunContext,
  type RunCursor,
} from "./run-context.js";
import { countVisit, recordNode, runObserved, type BranchDone } from "./node-step.js";

/**
 * Evaluate outgoing edges from a node and return the first matching
 * edge (first-match, sequential, in array order).
 *
 * Unconditional edges (no `condition`) always match.
 * Returns `null` when no edge matches — the caller should go to END.
 */
async function resolveEdge(
  outgoing: GraphEdge[],
  nodeResult: NodeResult,
): Promise<GraphEdge | null> {
  for (const edge of outgoing) {
    if (!edge.condition) {
      return edge;
    }
    const taken = await edge.condition(nodeResult);
    if (taken) {
      return edge;
    }
  }
  return null;
}

/**
 * Find the merge target for a set of parallel branch nodes.
 *
 * Scans outgoing edges of each parallel target, looking for a common
 * destination node whose {@link GraphNode.merge} flag is set.
 */
function findMergeNode(ctx: RunContext, parallelTargetIds: string[]): string | null {
  for (const targetId of parallelTargetIds) {
    for (const edge of ctx.edgesBySource.get(targetId) ?? []) {
      if (edge.to !== END && ctx.nodeMap.get(edge.to)?.merge) {
        return edge.to;
      }
    }
  }
  return null;
}

/** Run one parallel branch; null when the target is not an agent node. */
async function runBranch(
  ctx: RunContext,
  cursor: RunCursor,
  branch: { id: string; input: string },
): Promise<BranchDone | null> {
  const node = ctx.nodeMap.get(branch.id);
  if (!node) return null;
  countVisit(ctx, cursor, branch.id);
  const run = await runObserved(ctx, node, { input: branch.input, state: cursor.state });
  recordNode(ctx, cursor, { id: branch.id, run });
  return { id: branch.id, result: run.nodeResult };
}

/** Run every parallel target concurrently with the same input, then move to the merge node. */
async function forkParallel(
  ctx: RunContext,
  cursor: RunCursor,
  fork: { edges: GraphEdge[]; input: string },
): Promise<void> {
  const targets = fork.edges.map((e) => e.to).filter((t) => t !== END);
  for (const edge of fork.edges) {
    ctx.emit({ type: "edge:traverse", from: cursor.node_id, to: edge.to, label: edge.label });
  }
  const settled = await Promise.all(
    targets.map((id) => runBranch(ctx, cursor, { id, input: fork.input })),
  );
  const done = settled.filter((r): r is BranchDone => r !== null);
  const mergeNodeId = findMergeNode(ctx, targets);
  if (mergeNodeId) {
    for (const targetId of targets) {
      ctx.emit({ type: "edge:traverse", from: targetId, to: mergeNodeId });
    }
    // Concatenate branch outputs as merge input
    cursor.input = done.map((r) => `[from: ${r.id}]\n${r.result.output}`).join("\n\n");
    cursor.node_id = mergeNodeId;
  } else {
    // No merge node found — terminate. Use last branch output.
    cursor.input = done.at(-1)?.result.output ?? "";
    cursor.node_id = END;
  }
}

/** Follow the edges out of the node the cursor is on. */
async function advance(ctx: RunContext, cursor: RunCursor, nodeResult: NodeResult): Promise<void> {
  const outgoing = ctx.edgesBySource.get(cursor.node_id) ?? [];
  const parallelEdges = outgoing.filter((e) => e.parallel === true);
  if (parallelEdges.length > 1) {
    return forkParallel(ctx, cursor, { edges: parallelEdges, input: nodeResult.output });
  }
  // Sequential: first-match edge, or an implicit END when none matches.
  const taken = await resolveEdge(outgoing, nodeResult);
  if (taken) {
    ctx.emit({ type: "edge:traverse", from: cursor.node_id, to: taken.to, label: taken.label });
    cursor.node_id = taken.to;
    cursor.input = nodeResult.output;
  } else {
    cursor.node_id = END;
  }
}

/**
 * @internal Run a graph from wherever `cursor` stands until END, then emit
 * `graph:end` with the aggregate result.
 */
export async function continueGraph(ctx: RunContext, cursor: RunCursor): Promise<GraphRunResult> {
  while (cursor.node_id !== END) {
    const node = ctx.nodeMap.get(cursor.node_id);
    if (!node) break; // unreachable after validation
    const visit = countVisit(ctx, cursor, cursor.node_id);
    logger.debug({ node: cursor.node_id, visit }, "Graph node executing");
    const run = await runObserved(ctx, node, { input: cursor.input, state: cursor.state });
    recordNode(ctx, cursor, { id: cursor.node_id, run });
    await advance(ctx, cursor, run.nodeResult);
  }
  const result = buildResult(ctx, cursor);
  ctx.emit({ type: "graph:end", result });
  return result;
}

/**
 * Execute a graph from entrypoint to END.
 *
 * @param config  - Validated graph configuration.
 * @param runner  - AgentRunner used to execute each node's agent.
 * @param input   - User message fed to the entrypoint node.
 * @param options - Session, initial state, timeout, and loop cap.
 * @param onEvent - Optional callback for streaming graph events.
 * @returns Aggregate result with per-node outputs, path, and final output.
 */
export async function executeGraph(
  config: GraphConfig,
  runner: AgentRunner,
  input: string,
  options: RunOptions = {},
  onEvent?: (event: GraphEvent) => void,
): Promise<GraphRunResult> {
  const ctx = createRunContext(config, runner, { options, onEvent });
  const cursor = startCursor(config, input, options);
  ctx.emit({ type: "graph:start", entrypoint: config.entrypoint });
  return continueGraph(ctx, cursor);
}
