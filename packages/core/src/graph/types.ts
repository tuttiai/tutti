/**
 * Type definitions for the TuttiGraph DAG execution engine.
 *
 * A graph is a set of {@link GraphNode}s connected by {@link GraphEdge}s.
 * Each node wraps an {@link AgentConfig} and produces a {@link NodeResult}.
 * Edges can be unconditional (always taken) or conditional (evaluated
 * against the source node's result). The graph terminates when an edge
 * targets {@link END}.
 */

import type { ZodType } from "zod";
import type { AgentConfig, TokenUsage } from "@tuttiai/types";

// ── Sentinel ──────────────────────────────────────────────────

/** Terminal edge target — signals the graph should stop after this node. */
export const END = "__end__" as const;

// ── Node & Edge ───────────────────────────────────────────────

/**
 * A single node in the graph. Each node executes one agent.
 */
export interface GraphNode {
  /** Unique identifier within this graph. Used as the key in edge `from`/`to`. */
  id: string;
  /** Agent configuration to execute at this node. */
  agent: AgentConfig;
  /** Human-readable description for visualization and debugging. */
  description?: string;
  /**
   * When `true`, this node is a merge point for parallel branches.
   * It waits for all parallel predecessors to complete and receives
   * their concatenated outputs as input.
   */
  merge?: boolean;
}

/**
 * A directed edge connecting two nodes (or a node to {@link END}).
 *
 * When a source node completes, all outgoing edges are evaluated:
 * - Edges without a `condition` are unconditional (always taken).
 * - Edges with a `condition` are taken only when it returns `true`.
 *
 * If multiple outgoing edges are taken simultaneously, their target
 * nodes execute in parallel (fork). See DESIGN.md for full semantics.
 */
export interface GraphEdge {
  /** Source node ID. */
  from: string;
  /** Target node ID, or {@link END} (`"__end__"`) to terminate the graph. */
  to: string | typeof END;
  /**
   * Optional predicate evaluated against the source node's result.
   * When omitted the edge is unconditional (always taken).
   * When present the edge is taken only if this returns `true`.
   */
  condition?: (result: NodeResult) => boolean | Promise<boolean>;
  /** Human-readable label for visualization and debugging. */
  label?: string;
  /**
   * When `true`, this edge participates in a parallel fork.
   * All `parallel` edges from the same source node run their targets
   * concurrently. Results merge at the first downstream node with
   * {@link GraphNode.merge} set.
   */
  parallel?: boolean;
}

// ── Config ────────────────────────────────────────────────────

/**
 * Full configuration for a {@link TuttiGraph}.
 *
 * Validated at construction time — the constructor throws
 * {@link GraphValidationError} if the config is invalid (dangling
 * edges, missing entrypoint, duplicate node IDs, etc.).
 */
export interface GraphConfig {
  /** All nodes in the graph. Order is not significant. */
  nodes: GraphNode[];
  /** All edges connecting nodes. Order is not significant. */
  edges: GraphEdge[];
  /**
   * Optional Zod schema defining the shape of shared graph state.
   *
   * When provided, the initial state (from {@link RunOptions.initial_state}
   * or the schema's defaults) is validated at run start, and the state
   * is re-validated after every node execution. A validation failure
   * throws {@link GraphStateError}.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state?: ZodType<unknown, any, any>;
  /** Node ID where execution begins. Must match a node in `nodes`. */
  entrypoint: string;
}

// ── Results ───────────────────────────────────────────────────

/**
 * Result produced by a single graph node after its agent completes.
 */
export interface NodeResult {
  /** Text output from the agent. */
  output: string;
  /**
   * Parsed structured output — present when the node's agent has
   * {@link AgentConfig.outputSchema} set and validation succeeds.
   */
  structured?: unknown;
  /**
   * Arbitrary metadata produced during execution. The runtime populates
   * `duration_ms`, `turns`, and `edges_taken`; nodes may add more via
   * the state reducer.
   */
  metadata: Record<string, unknown>;
}

/**
 * Aggregate result from a complete graph execution.
 */
export interface GraphRunResult {
  /** Per-node results keyed by node ID. For nodes visited multiple times (loops), holds the last result. */
  outputs: Record<string, NodeResult>;
  /** Ordered list of node IDs visited during execution (includes repeats from loops). */
  path: string[];
  /** Output from the last node before {@link END}. */
  final_output: string;
  /** Aggregated token usage across all node executions. */
  total_usage: TokenUsage;
  /** Wall-clock duration of the full graph run in milliseconds. */
  duration_ms: number;
  /** Final state object — present when {@link GraphConfig.state} is defined. */
  final_state?: Record<string, unknown>;
}

// ── Run Options ───────────────────────────────────────────────

/**
 * Options passed to {@link TuttiGraph.run} and {@link TuttiGraph.stream}.
 */
export interface RunOptions {
  /** Session ID — passed through to every node's agent runner. */
  session_id?: string;
  /**
   * Initial state object. Must conform to {@link GraphConfig.state} if
   * a state schema is defined. Defaults to the schema's parsed defaults
   * (i.e. `state.parse({})`) when omitted.
   */
  initial_state?: Record<string, unknown>;
  /** Overall graph execution timeout in milliseconds. No limit when omitted. */
  timeout_ms?: number;
  /**
   * Maximum times any single node may be visited during one run.
   * Prevents infinite loops from self-referencing or cyclic edges.
   * Default: 10. Exceeding this throws {@link GraphCycleError}.
   */
  max_node_visits?: number;
}

// ── Streaming Events ──────────────────────────────────────────

/**
 * Events yielded by {@link TuttiGraph.stream}.
 *
 * Follows the same discriminated-union pattern as {@link TuttiEvent}.
 * The `type` field discriminates the union; consumers match on it.
 */
export type GraphEvent =
  | { type: "graph:start"; entrypoint: string }
  | { type: "graph:end"; result: GraphRunResult }
  | { type: "node:start"; node_id: string; input: string }
  | { type: "node:end"; node_id: string; result: NodeResult }
  | { type: "node:skip"; node_id: string; reason: string }
  | { type: "edge:evaluate"; from: string; to: string; label?: string; taken: boolean }
  | { type: "edge:traverse"; from: string; to: string; label?: string }
  | { type: "state:update"; node_id: string; state: Record<string, unknown> };
