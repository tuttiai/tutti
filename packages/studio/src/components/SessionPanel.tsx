import { useEffect, useState } from "react";

import type { ExecutionState } from "../hooks/useExecutionStream.js";

interface SessionPanelProps {
  state: ExecutionState;
}

/**
 * Right-panel summary of the active (or most recent) run.
 *
 * Re-renders on every 200 ms tick while a run is in flight so the
 * "elapsed" line stays live. The interval is cleared as soon as the
 * run completes — no work happens while idle.
 */
export function SessionPanel({ state }: SessionPanelProps) {
  const elapsedMs = useElapsedMs(state);

  if (state.status === "idle") {
    return (
      <div className="session-panel">
        <div className="session-panel__empty">
          No run yet. Type an input above and press <kbd>Run</kbd> to
          execute the configured graph.
        </div>
      </div>
    );
  }

  return (
    <div className="session-panel">
      <div className="session-panel__row">
        <span className="session-panel__label">Status</span>
        <span className={`session-panel__status session-panel__status--${state.status}`}>
          {state.status}
        </span>
      </div>
      <div className="session-panel__row">
        <span className="session-panel__label">Session</span>
        <span className="session-panel__value session-panel__value--mono">
          {state.session_id ?? "—"}
        </span>
      </div>
      <div className="session-panel__row">
        <span className="session-panel__label">Current node</span>
        <span className="session-panel__value">
          {state.current_node_id ?? "—"}
        </span>
      </div>
      <div className="session-panel__row">
        <span className="session-panel__label">Elapsed</span>
        <span className="session-panel__value session-panel__value--mono">
          {formatDuration(elapsedMs)}
        </span>
      </div>
      {state.path.length > 0 ? (
        <div className="session-panel__row session-panel__row--column">
          <span className="session-panel__label">Path</span>
          <span className="session-panel__value session-panel__value--mono">
            {state.path.join(" → ")}
          </span>
        </div>
      ) : null}
      {state.error_message !== null ? (
        <div className="session-panel__row session-panel__row--column session-panel__error">
          <span className="session-panel__label">Error</span>
          <span className="session-panel__value">{state.error_message}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compute the elapsed time of the run: live-ticking while running,
 * frozen at completion otherwise. Returns 0 when no run has started.
 */
function useElapsedMs(state: ExecutionState): number {
  const { status, started_at, completed_at } = state;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "running") return;
    const handle = setInterval(() => setNow(Date.now()), 200);
    return (): void => clearInterval(handle);
  }, [status]);

  if (started_at === null) return 0;
  if (status === "running") return Math.max(0, now - started_at);
  if (completed_at !== null) return Math.max(0, completed_at - started_at);
  return 0;
}

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
