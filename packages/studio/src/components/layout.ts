import dagre from "dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";

import type { GraphEdge, GraphPayload } from "../api.js";
import type { ExecutionState } from "../hooks/useExecutionStream.js";
import type { AgentNodeData } from "./AgentNode.js";

/**
 * Width/height used for both ReactFlow rendering and dagre's layout
 * calculation. Keeping them in lock-step is what makes dagre place
 * nodes so they don't overlap once rendered.
 */
const NODE_WIDTH = 180;
const NODE_HEIGHT = 84;

const END_NODE_ID = "__end__";

/**
 * Run dagre on the API payload and produce ReactFlow nodes + edges.
 *
 * Layout is top-to-bottom (`rankdir: TB`) — typical for agent DAGs that
 * read like a flowchart. Dagre returns the centre coordinate of each
 * node; ReactFlow expects the top-left corner, so we offset by half the
 * node dimensions.
 *
 * The optional `execution` argument layers live run state on top of the
 * static structure: per-node status flows into `node.data.run_status`,
 * and edges along the completed path get a blue highlight.
 */
export function layoutGraph(
  payload: GraphPayload,
  execution?: ExecutionState,
): { nodes: Node<AgentNodeData>[]; edges: Edge[] } {
  if (payload.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const path = execution?.path ?? [];
  const onPath = new Set(path);
  const traversedEdges = pathToEdgeSet(path);

  const g = new dagre.graphlib.Graph<Record<string, never>>();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 70, marginx: 24, marginy: 24 });

  for (const n of payload.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of payload.edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const nodes: Node<AgentNodeData>[] = payload.nodes.map((n) => {
    const pos = g.node(n.id);
    const variant = nodeVariant(n.id, payload.entrypoint);
    const runStatus = execution?.nodes[n.id];
    return {
      id: n.id,
      type: "agent",
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: {
        id: n.id,
        ...(n.label !== undefined ? { label: n.label } : {}),
        ...(n.description !== undefined ? { description: n.description } : {}),
        ...(n.merge !== undefined ? { merge: n.merge } : {}),
        variant,
        ...(runStatus !== undefined ? { run_status: runStatus } : {}),
        on_path: onPath.has(n.id),
      },
      // ReactFlow expects { width, height } so it can compute correct
      // edge endpoints even before the DOM measures the rendered card.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const edges: Edge[] = payload.edges.map((e, i) =>
    buildEdge(e, i, traversedEdges.has(edgeKey(e.source, e.target))),
  );

  return { nodes, edges };
}

/**
 * Convert a `path` (ordered node ids) into a set of `from→to` keys so
 * `buildEdge` can ask "was this edge traversed?" in O(1).
 */
function pathToEdgeSet(path: string[]): Set<string> {
  const out = new Set<string>();
  let prev: string | undefined;
  for (const node of path) {
    if (prev !== undefined) out.add(edgeKey(prev, node));
    prev = node;
  }
  return out;
}

function edgeKey(source: string, target: string): string {
  return `${source}→${target}`;
}

function nodeVariant(
  id: string,
  entrypoint: string | undefined,
): AgentNodeData["variant"] {
  if (id === END_NODE_ID) return "end";
  if (entrypoint !== undefined && id === entrypoint) return "entrypoint";
  return "regular";
}

function buildEdge(e: GraphEdge, index: number, traversed: boolean): Edge {
  const dashed = e.has_condition === true;
  const stroke = traversed ? "#2563eb" : "#94a3b8";
  return {
    id: `e${index}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    ...(e.label !== undefined ? { label: e.label } : {}),
    type: "smoothstep",
    animated: e.parallel === true,
    style: {
      stroke,
      strokeWidth: traversed ? 2.5 : 1.5,
      ...(dashed ? { strokeDasharray: "6 4" } : {}),
    },
    labelStyle: { fontSize: 11, fill: traversed ? "#1d4ed8" : "#475569" },
    labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
  };
}
