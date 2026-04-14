/**
 * TuttiGraph — DAG-based multi-agent execution engine.
 *
 * Executes a directed graph of agents where each node runs an
 * {@link AgentConfig} and edges control flow between them. Supports
 * conditional branching, parallel forks, shared state, and safe
 * loop handling. See `DESIGN.md` for architecture details.
 *
 * @example
 * ```typescript
 * import { TuttiGraph, END } from "@tuttiai/core";
 *
 * const graph = new TuttiGraph({
 *   entrypoint: "classifier",
 *   nodes: [
 *     { id: "classifier", agent: classifierAgent },
 *     { id: "writer",     agent: writerAgent },
 *     { id: "reviewer",   agent: reviewerAgent },
 *   ],
 *   edges: [
 *     { from: "classifier", to: "writer",   condition: (r) => r.output.includes("write") },
 *     { from: "classifier", to: "reviewer", condition: (r) => r.output.includes("review") },
 *     { from: "writer",     to: END },
 *     { from: "reviewer",   to: END },
 *   ],
 * });
 *
 * const result = await graph.run("Summarize this document");
 * console.log(result.final_output);
 * console.log(result.path); // ["classifier", "writer"]
 * ```
 */

import type { AgentRunner } from "../agent-runner.js";
import type {
  GraphConfig,
  GraphEvent,
  GraphRunResult,
  RunOptions,
} from "./types.js";
import { GraphValidationError } from "./errors.js";
import { executeGraph } from "./engine.js";

/** @internal Default loop cap — used by run()/stream() implementation. */
export const DEFAULT_MAX_NODE_VISITS = 10;

/**
 * DAG-based multi-agent execution engine.
 *
 * Construct with a {@link GraphConfig}, then call {@link run} for a
 * complete result or {@link stream} for incremental {@link GraphEvent}s.
 *
 * The constructor validates the graph structure eagerly — invalid
 * configs throw {@link GraphValidationError} immediately rather than
 * failing at runtime.
 */
export class TuttiGraph {
  /** @internal Retained for implementation — the validated graph config. */
  readonly config: GraphConfig;

  private readonly runner: AgentRunner;

  /**
   * Create a new graph. Validates the config and throws
   * {@link GraphValidationError} on structural problems.
   *
   * @param config - Graph definition: nodes, edges, optional state schema, entrypoint.
   * @param runner - AgentRunner used to execute each node's agent.
   * @throws {GraphValidationError} When the config is invalid.
   */
  constructor(config: GraphConfig, runner: AgentRunner) {
    this.config = config;
    this.runner = runner;
    this.validate();
  }

  /**
   * Execute the graph to completion.
   *
   * Starts at the entrypoint node, feeds `input` as the first node's
   * user message, and follows edges until an {@link END} edge is reached
   * or no outgoing edge is taken. Each node's agent is run via the
   * framework's `AgentRunner`.
   *
   * @param input   - User message passed to the entrypoint node.
   * @param options - Optional session, initial state, timeout, and loop cap.
   * @returns Aggregate result with per-node outputs, execution path, and final output.
   *
   * @throws {GraphCycleError}   When a node is visited more than `max_node_visits` times.
   * @throws {GraphStateError}   When state mutation fails Zod validation.
   * @throws {GuardrailError}    When a node's guardrail hook aborts the run.
   */
  async run(input: string, options?: RunOptions): Promise<GraphRunResult> {
    return executeGraph(this.config, this.runner, input, options);
  }

  /**
   * Execute the graph and yield events incrementally.
   *
   * Same execution semantics as {@link run}, but yields
   * {@link GraphEvent}s as each node starts, completes, and as edges
   * are evaluated and traversed. Useful for real-time UIs and
   * progress tracking.
   *
   * @param input   - User message passed to the entrypoint node.
   * @param options - Optional session, initial state, timeout, and loop cap.
   * @yields {GraphEvent} Events in execution order.
   */
  async *stream(input: string, options?: RunOptions): AsyncIterable<GraphEvent> {
    const events: GraphEvent[] = [];
    const result = await executeGraph(
      this.config,
      this.runner,
      input,
      options,
      (event) => events.push(event),
    );

    for (const event of events) {
      yield event;
    }

    // Ensure graph:end is always the last event
    const hasEnd = events.some((e) => e.type === "graph:end");
    if (!hasEnd) {
      yield { type: "graph:end", result };
    }
  }

  /**
   * Validate the graph config at construction time.
   *
   * Checks performed:
   * 1. At least one node exists.
   * 2. No duplicate node IDs.
   * 3. Entrypoint references an existing node.
   * 4. Every edge's `from` references an existing node.
   * 5. Every edge's `to` references an existing node or is `END`.
   * 6. Every non-terminal node has at least one outgoing edge.
   *
   * @throws {GraphValidationError} On the first structural problem found.
   */
  private validate(): void {
    const { nodes, edges, entrypoint } = this.config;
    const nodeIds = new Set(nodes.map((n) => n.id));

    if (nodes.length === 0) {
      throw new GraphValidationError("Graph must have at least one node.");
    }

    // Duplicate IDs
    if (nodeIds.size !== nodes.length) {
      const counts = new Map<string, number>();
      for (const n of nodes) {
        counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
      }
      const dupes = [...counts.entries()]
        .filter(([, c]) => c > 1)
        .map(([id]) => id);
      throw new GraphValidationError(
        `Duplicate node IDs: ${dupes.join(", ")}`,
        { duplicates: dupes },
      );
    }

    // Entrypoint
    if (!nodeIds.has(entrypoint)) {
      throw new GraphValidationError(
        `Entrypoint "${entrypoint}" does not match any node ID.\n` +
          `Available nodes: ${[...nodeIds].join(", ")}`,
        { entrypoint, available: [...nodeIds] },
      );
    }

    // Edge references
    for (const edge of edges) {
      if (!nodeIds.has(edge.from)) {
        throw new GraphValidationError(
          `Edge from "${edge.from}" references a non-existent node.`,
          { edge_from: edge.from, edge_to: edge.to },
        );
      }
      if (edge.to !== "__end__" && !nodeIds.has(edge.to)) {
        throw new GraphValidationError(
          `Edge to "${edge.to}" references a non-existent node.`,
          { edge_from: edge.from, edge_to: edge.to },
        );
      }
    }

    // Every non-terminal node must have at least one outgoing edge.
    // Terminal = has at least one edge to END.
    const nodesWithOutgoing = new Set(edges.map((e) => e.from));
    for (const id of nodeIds) {
      if (!nodesWithOutgoing.has(id)) {
        throw new GraphValidationError(
          `Node "${id}" has no outgoing edges. ` +
            `Add at least one edge from this node (or an edge to END).`,
          { node_id: id },
        );
      }
    }
  }
}

// Re-export types and errors for convenience
export { END } from "./types.js";
export type {
  GraphConfig,
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphRunResult,
  NodeResult,
  RunOptions,
} from "./types.js";
export {
  GraphValidationError,
  GraphCycleError,
  GraphDeadEndError,
  GraphStateError,
} from "./errors.js";
export { defineGraph, GraphBuilder } from "./dsl.js";
export type { EdgeOptions, NodeOptions } from "./dsl.js";
export { renderGraph, graphToJSON } from "./visualize.js";
