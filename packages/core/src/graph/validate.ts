/**
 * Structural validation for {@link GraphConfig}, run once when a
 * {@link TuttiGraph} is constructed.
 */

import type { GraphConfig, GraphEdge, GraphNode } from "./types.js";
import { GraphValidationError } from "./errors.js";
import { validateWaitNodes } from "./wait-validate.js";

export { assertNoWaitNodes } from "./wait-validate.js";

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
 * 7. Wait nodes, when declared, pass {@link validateWaitNodes}; their ids
 *    count as nodes for checks 4 to 6.
 *
 * @param config - The graph definition to check.
 * @throws {GraphValidationError} On the first structural problem found.
 */
export function validateGraphConfig(config: GraphConfig): void {
  const { nodes, edges, entrypoint } = config;
  const nodeIds = new Set(nodes.map((n) => n.id));

  if (nodes.length === 0) {
    throw new GraphValidationError("Graph must have at least one node.");
  }
  checkDuplicateIds(nodes, nodeIds);
  const waitIds = validateWaitNodes(config, nodeIds);
  checkEntrypoint(entrypoint, nodeIds);
  const allIds = new Set([...nodeIds, ...waitIds]);
  checkEdgeReferences(edges, allIds);
  checkOutgoingEdges(edges, allIds);
}

function checkDuplicateIds(nodes: GraphNode[], nodeIds: Set<string>): void {
  if (nodeIds.size === nodes.length) return;
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

function checkEntrypoint(entrypoint: string, nodeIds: Set<string>): void {
  if (nodeIds.has(entrypoint)) return;
  throw new GraphValidationError(
    `Entrypoint "${entrypoint}" does not match any node ID.\n` +
      `Available nodes: ${[...nodeIds].join(", ")}`,
    { entrypoint, available: [...nodeIds] },
  );
}

function checkEdgeReferences(edges: GraphEdge[], nodeIds: Set<string>): void {
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
}

/**
 * Every non-terminal node must have at least one outgoing edge.
 * Terminal = has at least one edge to END.
 */
function checkOutgoingEdges(edges: GraphEdge[], nodeIds: Set<string>): void {
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
