import { useEffect, useReducer } from "react";

import type { ExecutionEvent } from "../api.js";

/** Per-node visual status driven by execution events. */
export type NodeRunStatus =
  | { kind: "running" }
  | { kind: "complete"; output: string; duration_ms: number }
  | { kind: "error"; error: string; duration_ms: number };

/** Top-level run lifecycle. */
export type RunStatus = "idle" | "running" | "complete" | "error";

export interface ExecutionState {
  status: RunStatus;
  /** Session id from the most recent run (null until run:start). */
  session_id: string | null;
  /** Current per-node statuses, keyed by node id. */
  nodes: Record<string, NodeRunStatus>;
  /** Path of node ids visited — populated on run:complete. */
  path: string[];
  /** Last node that started — drives "current node" in the inspector. */
  current_node_id: string | null;
  /**
   * Wall-clock start of the active run (`performance.now()` style ms).
   * Null between runs.
   */
  started_at: number | null;
  /** Wall-clock end of the most recent run. */
  completed_at: number | null;
  /** Friendly error message attached to the run when one fails. */
  error_message: string | null;
}

const INITIAL_STATE: ExecutionState = {
  status: "idle",
  session_id: null,
  nodes: {},
  path: [],
  current_node_id: null,
  started_at: null,
  completed_at: null,
  error_message: null,
};

type Action = { type: "event"; event: ExecutionEvent } | { type: "reset" };

function reducer(state: ExecutionState, action: Action): ExecutionState {
  if (action.type === "reset") return INITIAL_STATE;
  const e = action.event;
  switch (e.type) {
    case "run:start":
      return {
        ...INITIAL_STATE,
        status: "running",
        session_id: e.session_id,
        started_at: Date.now(),
      };
    case "node:start":
      return {
        ...state,
        nodes: { ...state.nodes, [e.node_id]: { kind: "running" } },
        current_node_id: e.node_id,
      };
    case "node:complete":
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [e.node_id]: {
            kind: "complete",
            output: e.output,
            duration_ms: e.duration_ms,
          },
        },
      };
    case "node:error":
      return {
        ...state,
        status: "error",
        error_message: e.error,
        nodes: {
          ...state.nodes,
          [e.node_id]: {
            kind: "error",
            error: e.error,
            duration_ms: e.duration_ms,
          },
        },
      };
    case "run:complete":
      return {
        ...state,
        // Don't downgrade an error run back to "complete".
        status: state.status === "error" ? "error" : "complete",
        path: e.path,
        current_node_id: null,
        completed_at: Date.now(),
      };
    default:
      return state;
  }
}

/**
 * Subscribe to `GET /studio/events` and accumulate the latest run state
 * into a single immutable snapshot.
 *
 * Auto-reconnects when the connection drops. The `EventSource`'s
 * built-in reconnect handles transient network blips for us — the
 * onerror handler exists only to surface state to React if we ever want
 * to render a "disconnected" indicator (not in this step's spec).
 */
export function useExecutionStream(): ExecutionState {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    const source = new EventSource("/studio/events");
    source.onmessage = (msg): void => {
      try {
        const event = JSON.parse(msg.data) as ExecutionEvent;
        dispatch({ type: "event", event });
      } catch {
        // Malformed frame — ignore. Server only emits valid JSON.
      }
    };
    return (): void => {
      source.close();
    };
  }, []);

  return state;
}
