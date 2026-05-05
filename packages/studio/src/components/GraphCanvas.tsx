import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { useGraph } from "../hooks/useGraph.js";
import type { ExecutionState } from "../hooks/useExecutionStream.js";
import { AgentNode, type AgentNodeData } from "./AgentNode.js";
import { layoutGraph } from "./layout.js";

export interface SelectedNode {
  id: string;
  label?: string;
  description?: string;
  variant: AgentNodeData["variant"];
}

interface GraphCanvasProps {
  /**
   * Live execution state from `useExecutionStream`. Lifted to
   * `<App>` so the right-panel inspector can render the same
   * snapshot the canvas does.
   */
  execution: ExecutionState;
  /**
   * Called whenever the user clicks a node. The right-panel inspector
   * uses this to render the node's details. Pass `null` to clear.
   */
  onSelect: (node: SelectedNode | null) => void;
}

const NODE_TYPES: NodeTypes = { agent: AgentNode };

/**
 * The main TuttiGraph visual canvas.
 *
 * Polls `GET /graph` every 5 s, lays the graph out top-to-bottom with
 * dagre, and renders nodes + edges via ReactFlow. Includes built-in
 * zoom in / out / fit-view controls plus a togglable mini-map.
 */
export function GraphCanvas({ execution, onSelect }: GraphCanvasProps) {
  const graph = useGraph(5000);

  const { nodes, edges } = useMemo<{ nodes: Node<AgentNodeData>[]; edges: Edge[] }>(
    () => layoutGraph(graph, execution),
    [graph, execution],
  );

  const [showMiniMap, setShowMiniMap] = useState(true);

  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const d = node.data as AgentNodeData;
      onSelect({
        id: d.id,
        ...(d.label !== undefined ? { label: d.label } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        variant: d.variant,
      });
    },
    [onSelect],
  );

  const handlePaneClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  if (nodes.length === 0) {
    return (
      <div className="graph-canvas graph-canvas--empty">
        <div className="graph-canvas__empty-card">
          <div className="graph-canvas__empty-title">No graph configured</div>
          <div className="graph-canvas__empty-body">
            Attach a TuttiGraph to your score to see it here. The canvas
            polls <code>GET /graph</code> every 5 seconds, so changes
            from hot reload appear automatically.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-canvas">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          // Default behaviour is fine — users still get pan + scroll-zoom.
          // Disable connection drag since the graph here is read-only.
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
          <Controls position="bottom-right" showInteractive={false} />
          {showMiniMap ? (
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              nodeStrokeWidth={2}
              nodeColor={(n) => {
                const v = (n.data as AgentNodeData | undefined)?.variant;
                if (v === "entrypoint") return "#2563eb";
                if (v === "end") return "#16a34a";
                return "#cbd5e1";
              }}
            />
          ) : null}
          <MiniMapToggle visible={showMiniMap} onToggle={() => setShowMiniMap((v) => !v)} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

interface MiniMapToggleProps {
  visible: boolean;
  onToggle: () => void;
}

/**
 * A small button overlaid on the canvas that hides / shows the mini-map.
 *
 * Implemented inline (rather than as a ReactFlow `Panel`) to keep the
 * canvas self-contained — no extra imports for one button.
 */
function MiniMapToggle({ visible, onToggle }: MiniMapToggleProps) {
  return (
    <button
      type="button"
      className="graph-canvas__minimap-toggle"
      onClick={onToggle}
      aria-pressed={visible}
      title={visible ? "Hide mini-map" : "Show mini-map"}
    >
      {visible ? "Hide map" : "Show map"}
    </button>
  );
}
