import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { NodeRunStatus } from "../hooks/useExecutionStream.js";

/** Data field carried by each ReactFlow node we render. */
export interface AgentNodeData extends Record<string, unknown> {
  id: string;
  label?: string;
  description?: string;
  merge?: boolean;
  variant: "entrypoint" | "regular" | "end";
  /** Live execution status from the most recent run, if any. */
  run_status?: NodeRunStatus;
  /** True when the node was part of the last completed run's path. */
  on_path?: boolean;
}

const VARIANT_BORDER = new Map<AgentNodeData["variant"], string>([
  ["entrypoint", "#2563eb"],
  ["regular", "#94a3b8"],
  ["end", "#16a34a"],
]);

const VARIANT_BG = new Map<AgentNodeData["variant"], string>([
  ["entrypoint", "#eff6ff"],
  ["regular", "#ffffff"],
  ["end", "#ecfdf5"],
]);

const FALLBACK_BORDER = "#94a3b8";
const FALLBACK_BG = "#ffffff";

interface RunVisuals {
  border: string;
  background: string;
  badge: string | null;
  className: string;
}

/**
 * Resolve the visual style for a node given its run state.
 *
 * Run state takes precedence over the static variant — e.g. a green
 * "complete" border overrides the gray "regular" border. This lets the
 * canvas feel live without callers having to swap variants.
 */
function resolveRunVisuals(
  variant: AgentNodeData["variant"],
  status: NodeRunStatus | undefined,
  onPath: boolean,
): RunVisuals {
  if (status?.kind === "running") {
    return {
      border: "#3b82f6",
      background: "#eff6ff",
      badge: null,
      className: "agent-node--running",
    };
  }
  if (status?.kind === "complete") {
    return {
      border: "#16a34a",
      background: "#f0fdf4",
      badge: `✓ ${formatDuration(status.duration_ms)}`,
      className: "agent-node--complete",
    };
  }
  if (status?.kind === "error") {
    return {
      border: "#dc2626",
      background: "#fef2f2",
      badge: "! error",
      className: "agent-node--error",
    };
  }
  return {
    border: VARIANT_BORDER.get(variant) ?? FALLBACK_BORDER,
    background: VARIANT_BG.get(variant) ?? FALLBACK_BG,
    badge: null,
    className: onPath ? "agent-node--on-path" : "",
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Custom card rendered for every node on the canvas.
 *
 * Three visual variants drive the border colour:
 *  - `entrypoint` — blue, the graph's starting node.
 *  - `regular` — gray, every other configured node.
 *  - `end` — green, the synthetic `__end__` sentinel.
 *
 * The card has a fixed 180 px width to match dagre's layout
 * calculation. Top + bottom handles let ReactFlow draw vertical edges
 * cleanly under the default top-to-bottom layout.
 */
export function AgentNode({ data }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const visuals = resolveRunVisuals(d.variant, d.run_status, d.on_path === true);

  return (
    <div
      className={`agent-node ${visuals.className}`.trim()}
      style={{
        width: 180,
        background: visuals.background,
        border: `2px solid ${visuals.border}`,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: visuals.border }}
      />
      <div className="agent-node__title">{d.label ?? d.id}</div>
      {d.description !== undefined && d.description !== "" ? (
        <div className="agent-node__subtitle">{d.description}</div>
      ) : null}
      <div className="agent-node__badges">
        {d.merge === true ? <span className="agent-node__badge">merge</span> : null}
        {visuals.badge !== null ? (
          <span
            className={
              "agent-node__status-badge agent-node__status-badge--" +
              (d.run_status?.kind ?? "idle")
            }
          >
            {visuals.badge}
          </span>
        ) : null}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: visuals.border }}
      />
    </div>
  );
}
