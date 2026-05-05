import { useEffect, useState } from "react";

import { fetchSessions, type SessionSummary } from "../api.js";
import type { ExecutionState } from "../hooks/useExecutionStream.js";

interface SessionsListProps {
  /** Currently-selected session id (drives the active row highlight). */
  selectedId: string | null;
  /**
   * Live execution state — used to refresh the list whenever a run
   * completes or starts, in addition to the 5 s polling interval.
   */
  execution: ExecutionState;
  /** Called when the user picks a session. */
  onSelect: (session: SessionSummary) => void;
}

const POLL_MS = 5000;

/**
 * Sidebar list of past sessions known to this server.
 *
 * Polls `GET /sessions` every 5 s and additionally re-fetches whenever
 * the live run lifecycle ticks (`run:start`, `run:complete`,
 * `node:complete`, …). That keeps the list current without flooding
 * the server with requests.
 */
export function SessionsList({
  selectedId,
  execution,
  onSelect,
}: SessionsListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  // Poll regularly + tick whenever run state advances.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const next = await fetchSessions();
      if (!cancelled) setSessions(next);
    };

    void tick();
    const handle = setInterval(() => {
      void tick();
    }, POLL_MS);

    return (): void => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Re-fetch when the run state advances. Keying on the snapshot's
  // status + node count gives us a tick on every meaningful update
  // without re-fetching on harmless no-ops.
  const tickKey = `${execution.status}:${Object.keys(execution.nodes).length}`;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchSessions();
      if (!cancelled) setSessions(next);
    })();
    return (): void => {
      cancelled = true;
    };
  }, [tickKey]);

  if (sessions.length === 0) {
    return <div className="sessions-list__empty">No sessions yet</div>;
  }

  return (
    <ul className="sessions-list" role="list">
      {sessions.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            className={
              "sessions-list__item" +
              (s.id === selectedId ? " sessions-list__item--active" : "")
            }
            onClick={(): void => onSelect(s)}
            title={s.id}
          >
            <span className="sessions-list__row">
              <span className="sessions-list__agent">{s.agent_name}</span>
              <SessionStatusDot status={s.status} />
            </span>
            <span className="sessions-list__row sessions-list__row--meta">
              <span className="sessions-list__id">{s.id.slice(0, 8)}</span>
              <span className="sessions-list__count">
                {s.turn_count} turn{s.turn_count === 1 ? "" : "s"}
              </span>
            </span>
            <span className="sessions-list__time">{formatRelative(s.started_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionStatusDot({ status }: { status: SessionSummary["status"] }) {
  const cls = `sessions-list__dot sessions-list__dot--${status}`;
  return <span className={cls} aria-label={status} title={status} />;
}

/**
 * Format a timestamp as a short relative time. Falls back to the raw
 * ISO string after 24 h so we don't claim "5 days ago" when the
 * session list might span a development weekend.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleString();
}
