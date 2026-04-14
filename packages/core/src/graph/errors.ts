/**
 * Graph-specific error types. All extend {@link TuttiError}.
 */

import { TuttiError } from "../errors.js";

/**
 * Thrown at construction time when a {@link GraphConfig} is structurally
 * invalid — duplicate node IDs, dangling edge targets, missing entrypoint,
 * or nodes with no outgoing edges (except terminal nodes targeting END).
 */
export class GraphValidationError extends TuttiError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super("GRAPH_INVALID", message, context);
  }
}

/**
 * Thrown at runtime when a node's visit count exceeds
 * {@link RunOptions.max_node_visits} (default 10), indicating a likely
 * infinite loop through cyclic edges.
 */
export class GraphCycleError extends TuttiError {
  constructor(nodeId: string, visits: number, limit: number) {
    super(
      "GRAPH_CYCLE",
      `Node "${nodeId}" visited ${visits} times (limit: ${limit}).\n` +
        `This usually means a cyclic edge has no exit condition, or the ` +
        `condition never evaluates to false.\n` +
        `Increase max_node_visits in RunOptions if this is intentional.`,
      { node_id: nodeId, visits, limit },
    );
  }
}

/**
 * Thrown when the shared graph state fails Zod validation after a node
 * mutates it. Contains the raw state and the validation error.
 */
export class GraphStateError extends TuttiError {
  constructor(nodeId: string, validationError: string) {
    super(
      "GRAPH_STATE_INVALID",
      `State validation failed after node "${nodeId}" executed.\n` +
        `Error: ${validationError}\n` +
        `Ensure the node's output or state reducer produces a valid state object.`,
      { node_id: nodeId, validation_error: validationError },
    );
  }
}

/**
 * Thrown when a node completes but no outgoing edge is taken and no
 * edge targets {@link END}. The graph has no path forward.
 */
export class GraphDeadEndError extends TuttiError {
  constructor(nodeId: string) {
    super(
      "GRAPH_DEAD_END",
      `Node "${nodeId}" completed but no outgoing edge condition was ` +
        `satisfied and no unconditional edge exists.\n` +
        `Add a fallback unconditional edge or an edge to END.`,
      { node_id: nodeId },
    );
  }
}
