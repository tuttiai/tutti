/**
 * Graph execution engine — walks the node/edge graph, running each
 * node's agent through an {@link AgentRunner} and following edges
 * according to the algorithm in DESIGN.md.
 */

import type { TokenUsage } from "@tuttiai/types";
import type { AgentRunner } from "../agent-runner.js";
import type {
  GraphConfig,
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphRunResult,
  NodeResult,
  RunOptions,
} from "./types.js";
import { END } from "./types.js";
import { GraphCycleError, GraphStateError } from "./errors.js";
import { logger } from "../logger.js";

/** Default per-node visit cap. */
const DEFAULT_MAX_NODE_VISITS = 5;

/**
 * Run a single graph node by executing its agent and collecting the result.
 *
 * If the graph has a state schema and the current state is non-empty, the
 * state snapshot is appended to the agent's system prompt so the LLM can
 * read it.
 */
async function runNode(
  node: GraphNode,
  input: string,
  state: Record<string, unknown>,
  hasStateSchema: boolean,
  runner: AgentRunner,
): Promise<{ nodeResult: NodeResult; usage: TokenUsage }> {
  // Inject state into the agent's system prompt when a state schema exists
  const agent =
    hasStateSchema && Object.keys(state).length > 0
      ? {
          ...node.agent,
          system_prompt:
            node.agent.system_prompt +
            "\n\nCurrent graph state:\n" +
            JSON.stringify(state),
        }
      : node.agent;

  const start = Date.now();
  const result = await runner.run(agent, input);
  const duration = Date.now() - start;

  const nodeResult: NodeResult = {
    output: result.output,
    structured: result.structured,
    metadata: {
      duration_ms: duration,
      turns: result.turns,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    },
  };

  return { nodeResult, usage: result.usage };
}

/**
 * Attempt to shallow-merge a `state_update` from a node's structured
 * output into the shared state. Re-validates via the Zod schema when
 * one is defined.
 *
 * @returns The updated state, or the original state if no update was found.
 */
function applyStateUpdate(
  nodeId: string,
  nodeResult: NodeResult,
  state: Record<string, unknown>,
  config: GraphConfig,
): Record<string, unknown> {
  if (
    !nodeResult.structured ||
    typeof nodeResult.structured !== "object" ||
    nodeResult.structured === null
  ) {
    return state;
  }

  const structured = nodeResult.structured as Record<string, unknown>;
  if (
    !("state_update" in structured) ||
    typeof structured["state_update"] !== "object" ||
    structured["state_update"] === null
  ) {
    return state;
  }

  const merged = {
    ...state,
    ...(structured["state_update"] as Record<string, unknown>),
  };

  if (config.state) {
    try {
      return config.state.parse(merged) as Record<string, unknown>;
    } catch (err) {
      throw new GraphStateError(
        nodeId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return merged;
}

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
function findMergeNode(
  parallelTargetIds: string[],
  edgesBySource: Map<string, GraphEdge[]>,
  nodeMap: Map<string, GraphNode>,
): string | null {
  for (const targetId of parallelTargetIds) {
    const edges = edgesBySource.get(targetId) ?? [];
    for (const edge of edges) {
      if (edge.to !== END) {
        const candidate = nodeMap.get(edge.to);
        if (candidate?.merge) {
          return candidate.id;
        }
      }
    }
  }
  return null;
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
  const startTime = Date.now();
  const maxVisits = options.max_node_visits ?? DEFAULT_MAX_NODE_VISITS;
  const hasStateSchema = !!config.state;

  // ── Lookup tables ──────────────────────────────────────────────
  const nodeMap = new Map(config.nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const edge of config.edges) {
    const list = edgesBySource.get(edge.from) ?? [];
    list.push(edge);
    edgesBySource.set(edge.from, list);
  }

  // ── Mutable run state ──────────────────────────────────────────
  const visits = new Map<string, number>();
  const outputs = new Map<string, NodeResult>();
  const path: string[] = [];
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

  let state: Record<string, unknown> = {};
  if (config.state) {
    state = (
      options.initial_state
        ? config.state.parse(options.initial_state)
        : config.state.parse({})
    ) as Record<string, unknown>;
  } else if (options.initial_state) {
    state = { ...options.initial_state };
  }

  // Stamp every emitted event with the run's session_id (when one was
  // provided) so a global subscriber can correlate events with a run.
  const sessionId = options.session_id;
  const emit = (event: GraphEvent): void => {
    if (sessionId !== undefined && event.session_id === undefined) {
      onEvent?.({ ...event, session_id: sessionId });
    } else {
      onEvent?.(event);
    }
  };

  emit({ type: "graph:start", entrypoint: config.entrypoint });

  // ── Main loop ──────────────────────────────────────────────────
  let currentNodeId: string = config.entrypoint;
  let currentInput = input;

  while (currentNodeId !== END) {
    const node = nodeMap.get(currentNodeId);
    if (!node) break; // unreachable after validation

    // Loop guard
    const count = (visits.get(currentNodeId) ?? 0) + 1;
    visits.set(currentNodeId, count);
    if (count > maxVisits) {
      throw new GraphCycleError(currentNodeId, count, maxVisits);
    }

    logger.debug({ node: currentNodeId, visit: count }, "Graph node executing");
    emit({ type: "node:start", node_id: currentNodeId, input: currentInput });

    // Execute node — wrap in try/catch so observers see a `node:error`
    // before the throw bubbles up. Re-throw so existing run() callers
    // still get the exception.
    const nodeStartedAt = Date.now();
    let nodeResult: NodeResult;
    let usage: TokenUsage;
    try {
      const r = await runNode(node, currentInput, state, hasStateSchema, runner);
      nodeResult = r.nodeResult;
      usage = r.usage;
    } catch (err) {
      emit({
        type: "node:error",
        node_id: currentNodeId,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - nodeStartedAt,
      });
      throw err;
    }
    const nodeDuration = Date.now() - nodeStartedAt;

    totalUsage.input_tokens += usage.input_tokens;
    totalUsage.output_tokens += usage.output_tokens;
    outputs.set(currentNodeId, nodeResult);
    path.push(currentNodeId);

    // State update
    const nextState = applyStateUpdate(currentNodeId, nodeResult, state, config);
    if (nextState !== state) {
      state = nextState;
      emit({ type: "state:update", node_id: currentNodeId, state: { ...state } });
    }

    emit({
      type: "node:end",
      node_id: currentNodeId,
      result: nodeResult,
      duration_ms: nodeDuration,
    });

    // ── Edge evaluation ────────────────────────────────────────
    const outgoing = edgesBySource.get(currentNodeId) ?? [];
    const parallelEdges = outgoing.filter((e) => e.parallel === true);

    if (parallelEdges.length > 1) {
      // ── Parallel fork ────────────────────────────────────────
      const targets = parallelEdges.map((e) => e.to).filter((t): t is string => t !== END);

      for (const edge of parallelEdges) {
        emit({ type: "edge:traverse", from: currentNodeId, to: edge.to, label: edge.label });
      }

      // Run all parallel targets concurrently with the same input
      const branchInput = nodeResult.output;
      const branchResults = await Promise.all(
        targets.map(async (targetId) => {
          const targetNode = nodeMap.get(targetId);
          if (!targetNode) return null;

          const bCount = (visits.get(targetId) ?? 0) + 1;
          visits.set(targetId, bCount);
          if (bCount > maxVisits) {
            throw new GraphCycleError(targetId, bCount, maxVisits);
          }

          emit({ type: "node:start", node_id: targetId, input: branchInput });

          const branchStartedAt = Date.now();
          let branch: { nodeResult: NodeResult; usage: TokenUsage };
          try {
            branch = await runNode(targetNode, branchInput, state, hasStateSchema, runner);
          } catch (err) {
            emit({
              type: "node:error",
              node_id: targetId,
              error: err instanceof Error ? err.message : String(err),
              duration_ms: Date.now() - branchStartedAt,
            });
            throw err;
          }
          const branchDuration = Date.now() - branchStartedAt;

          totalUsage.input_tokens += branch.usage.input_tokens;
          totalUsage.output_tokens += branch.usage.output_tokens;
          outputs.set(targetId, branch.nodeResult);
          path.push(targetId);

          const branchState = applyStateUpdate(targetId, branch.nodeResult, state, config);
          if (branchState !== state) {
            state = branchState;
            emit({ type: "state:update", node_id: targetId, state: { ...state } });
          }

          emit({
            type: "node:end",
            node_id: targetId,
            result: branch.nodeResult,
            duration_ms: branchDuration,
          });

          return { id: targetId, result: branch.nodeResult };
        }),
      );

      // Find merge node
      const mergeNodeId = findMergeNode(targets, edgesBySource, nodeMap);
      if (mergeNodeId) {
        // Emit edge:traverse for each branch → merge
        for (const targetId of targets) {
          emit({ type: "edge:traverse", from: targetId, to: mergeNodeId });
        }
        // Concatenate branch outputs as merge input
        currentInput = branchResults
          .filter((r): r is { id: string; result: NodeResult } => r !== null)
          .map((r) => `[from: ${r.id}]\n${r.result.output}`)
          .join("\n\n");
        currentNodeId = mergeNodeId;
      } else {
        // No merge node found — terminate. Use last branch output.
        const last = branchResults.filter(
          (r): r is { id: string; result: NodeResult } => r !== null,
        ).at(-1);
        currentInput = last?.result.output ?? "";
        currentNodeId = END;
      }
      continue;
    }

    // ── Sequential: first-match edge ───────────────────────────
    const taken = await resolveEdge(outgoing, nodeResult);
    if (taken) {
      emit({ type: "edge:traverse", from: currentNodeId, to: taken.to, label: taken.label });
      currentNodeId = taken.to;
      currentInput = nodeResult.output;
    } else {
      // No matching edge — implicit END
      currentNodeId = END;
    }
  }

  // ── Build result ───────────────────────────────────────────────
  const lastNodeId = path.at(-1);
  const finalOutput = lastNodeId ? (outputs.get(lastNodeId)?.output ?? "") : "";

  const result: GraphRunResult = {
    outputs: Object.fromEntries(outputs),
    path,
    final_output: finalOutput,
    total_usage: totalUsage,
    duration_ms: Date.now() - startTime,
    ...(hasStateSchema ? { final_state: state } : {}),
  };

  emit({ type: "graph:end", result });
  return result;
}
