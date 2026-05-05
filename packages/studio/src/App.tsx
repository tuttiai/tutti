import { useCallback, useState } from "react";

import { GraphCanvas, type SelectedNode } from "./components/GraphCanvas.js";
import { ReplayView } from "./components/ReplayView.js";
import { RunBar } from "./components/RunBar.js";
import { SessionPanel } from "./components/SessionPanel.js";
import { SessionsList } from "./components/SessionsList.js";
import { useExecutionStream } from "./hooks/useExecutionStream.js";
import type { SessionSummary } from "./api.js";

type CenterTab = "graph" | "replay";

/**
 * Top-level Studio shell.
 *
 * Header        : title + Run input.
 * Left sidebar  : agents + graphs (placeholder) + Sessions history.
 * Centre panel  : tabbed — Graph (live canvas) | Replay (time-travel).
 * Right panel   : node inspector when a node is selected; otherwise the
 *                 active-session summary.
 *
 * Flow:
 *  1. User clicks a session in the left sidebar →
 *     `replaySession` set, center tab switches to Replay.
 *  2. Inside Replay, "Replay from here" reruns and calls `onReplayed`
 *     which flips the tab back to Graph so the user watches the new
 *     run play out live.
 */
export function App() {
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);
  const [centerTab, setCenterTab] = useState<CenterTab>("graph");
  const [replaySession, setReplaySession] = useState<SessionSummary | null>(null);
  const execution = useExecutionStream();

  const onSelectSession = useCallback((s: SessionSummary): void => {
    setReplaySession(s);
    setCenterTab("replay");
  }, []);

  const onReplayed = useCallback((): void => {
    setCenterTab("graph");
  }, []);

  return (
    <div className="studio">
      <header className="studio__topbar">
        <div className="studio__brand">Tutti Studio</div>
        <RunBar status={execution.status} />
      </header>

      <div className="studio__body">
        <aside className="studio__sidebar" aria-label="Agents, graphs, and sessions">
          <nav className="studio__list">
            <div className="studio__list-section">Agents</div>
            <div className="studio__list-empty">No agents loaded yet</div>
            <div className="studio__list-section">Graphs</div>
            <div className="studio__list-empty">No graphs loaded yet</div>
            <div className="studio__list-section">Sessions</div>
            <SessionsList
              selectedId={replaySession?.id ?? null}
              execution={execution}
              onSelect={onSelectSession}
            />
          </nav>
        </aside>

        <main className="studio__canvas">
          <CenterTabs
            tab={centerTab}
            onChange={setCenterTab}
            replayDisabled={replaySession === null}
          />
          <div className="studio__canvas-body">
            {centerTab === "graph" || replaySession === null ? (
              <GraphCanvas execution={execution} onSelect={setSelectedNode} />
            ) : (
              <ReplayView session={replaySession} onReplayed={onReplayed} />
            )}
          </div>
        </main>

        <aside className="studio__inspector" aria-label="Run details and inspector">
          {selectedNode !== null ? (
            <>
              <header className="studio__inspector-header">Inspector</header>
              <div className="studio__inspector-body">
                <NodeInspector
                  node={selectedNode}
                  execution={execution}
                  onClose={(): void => setSelectedNode(null)}
                />
              </div>
            </>
          ) : (
            <>
              <header className="studio__inspector-header">Session</header>
              <div className="studio__inspector-body">
                <SessionPanel state={execution} />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

interface CenterTabsProps {
  tab: CenterTab;
  onChange: (tab: CenterTab) => void;
  replayDisabled: boolean;
}

function CenterTabs({ tab, onChange, replayDisabled }: CenterTabsProps) {
  return (
    <div className="center-tabs" role="tablist" aria-label="Center panel">
      <button
        type="button"
        className={`center-tabs__tab${tab === "graph" ? " center-tabs__tab--active" : ""}`}
        role="tab"
        aria-selected={tab === "graph"}
        onClick={(): void => onChange("graph")}
      >
        Graph
      </button>
      <button
        type="button"
        className={`center-tabs__tab${tab === "replay" ? " center-tabs__tab--active" : ""}`}
        role="tab"
        aria-selected={tab === "replay"}
        disabled={replayDisabled}
        onClick={(): void => onChange("replay")}
        title={replayDisabled ? "Pick a session in the sidebar first" : undefined}
      >
        Replay
      </button>
    </div>
  );
}

interface NodeInspectorProps {
  node: SelectedNode;
  execution: ReturnType<typeof useExecutionStream>;
  onClose: () => void;
}

function NodeInspector({ node, execution, onClose }: NodeInspectorProps) {
  const variantLabel =
    node.variant === "entrypoint"
      ? "Entrypoint"
      : node.variant === "end"
        ? "Terminal"
        : "Agent node";
  const status = execution.nodes[node.id];
  return (
    <div className="inspector-card">
      <button
        type="button"
        className="inspector-card__close"
        onClick={onClose}
        aria-label="Close inspector"
      >
        ×
      </button>
      <div className={`inspector-card__pill inspector-card__pill--${node.variant}`}>
        {variantLabel}
      </div>
      <div className="inspector-card__title">{node.label ?? node.id}</div>
      {node.label !== undefined && node.label !== node.id ? (
        <div className="inspector-card__id">id: {node.id}</div>
      ) : null}
      {node.description !== undefined && node.description !== "" ? (
        <p className="inspector-card__desc">{node.description}</p>
      ) : (
        <p className="inspector-card__desc inspector-card__desc--muted">
          No description set.
        </p>
      )}
      {status !== undefined ? <NodeRunDetails status={status} /> : null}
    </div>
  );
}

function NodeRunDetails({
  status,
}: {
  status: NonNullable<ReturnType<typeof useExecutionStream>["nodes"][string]>;
}) {
  if (status.kind === "running") {
    return (
      <div className="inspector-card__run inspector-card__run--running">
        Running…
      </div>
    );
  }
  if (status.kind === "complete") {
    return (
      <div className="inspector-card__run inspector-card__run--complete">
        <div className="inspector-card__run-label">
          Completed in {formatMs(status.duration_ms)}
        </div>
        <pre className="inspector-card__run-output">{status.output}</pre>
      </div>
    );
  }
  return (
    <div className="inspector-card__run inspector-card__run--error">
      <div className="inspector-card__run-label">
        Failed after {formatMs(status.duration_ms)}
      </div>
      <pre className="inspector-card__run-output">{status.error}</pre>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
