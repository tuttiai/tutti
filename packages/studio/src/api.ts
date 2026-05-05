/**
 * Wire types and fetch helpers for the Tutti Studio frontend.
 *
 * The shapes here mirror the JSON returned by `@tuttiai/server`'s
 * `GET /graph` route (see `graphToJSON` in `@tuttiai/core`). They are
 * intentionally structural — the studio never imports core types
 * directly because it ships as a static SPA that can be served from any
 * Tutti server build.
 */

export interface GraphNode {
  /** Unique node id within the graph. */
  id: string;
  /** Display label — typically the agent's `name`. May equal `id`. */
  label?: string;
  /** Optional human-readable description shown as a subtitle. */
  description?: string;
  /** True when the node is a merge point for parallel branches. */
  merge?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Optional edge label — rendered alongside the arrow. */
  label?: string;
  /** True when the edge participates in a parallel fork. */
  parallel?: boolean;
  /** True when the source edge had a `condition` predicate. */
  has_condition?: boolean;
}

export interface GraphPayload {
  /** Node id where execution begins. Absent when no graph is configured. */
  entrypoint?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the graph has a state schema attached. */
  has_state?: boolean;
}

const EMPTY: GraphPayload = { nodes: [], edges: [] };

/**
 * Wire-format events delivered by `GET /studio/events` (SSE).
 *
 * Mirrors the discriminated union written by the server. The frontend
 * only consumes these — it never produces them.
 */
export type ExecutionEvent =
  | {
      type: "node:start";
      node_id: string;
      session_id: string | null;
      timestamp: number;
    }
  | {
      type: "node:complete";
      node_id: string;
      session_id: string | null;
      output: string;
      duration_ms: number;
    }
  | {
      type: "node:error";
      node_id: string;
      session_id: string | null;
      error: string;
      duration_ms: number;
    }
  | { type: "run:start"; session_id: string | null }
  | { type: "run:complete"; session_id: string | null; path: string[] };

/** Block inside a {@link ChatMessage} (text, tool call, tool result). */
export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id?: string;
      content: unknown;
      is_error?: boolean;
    };

/** A single conversation turn. */
export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | MessageBlock[];
  /** Optional aggregated token count surfaced by the runtime, when present. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Row returned by `GET /sessions`. */
export interface SessionSummary {
  id: string;
  started_at: string;
  status: "running" | "complete" | "error";
  turn_count: number;
  model: string;
  agent_name: string;
}

/** Body returned by `GET /sessions/:id/turns`. */
export interface SessionTurns {
  session_id: string;
  turns: ChatMessage[];
  count: number;
}

/** Body returned by `POST /sessions/:id/replay-from`. */
export interface ReplayResponse {
  session_id: string;
  replayed_from: number;
  truncated_to: number;
  output: string;
  turns: number;
  path?: string[];
}

/** Body sent to `POST /run`. */
export interface RunRequest {
  input: string;
  session_id?: string;
}

/** Body returned by `POST /run` (graph or agent mode). */
export interface RunResponse {
  output: string;
  session_id: string;
  turns: number;
  duration_ms: number;
}

/**
 * POST `/run` with a user-supplied input.
 *
 * Returns the response on 2xx. Throws a plain `Error` with a useful
 * message otherwise — this is fine because the caller (UI) only
 * surfaces `err.message` to the user; nothing structured is needed.
 */
export async function runAgent(req: RunRequest): Promise<RunResponse> {
  const res = await fetch("/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Run failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as RunResponse;
}

/** GET `/sessions` — list of sessions known to the server, newest first. */
export async function fetchSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  try {
    const res = await fetch("/sessions", signal ? { signal } : {});
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as SessionSummary[]) : [];
  } catch {
    return [];
  }
}

/** GET `/sessions/:id/turns` — full conversation history for one session. */
export async function fetchSessionTurns(id: string): Promise<SessionTurns> {
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/turns`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to load session turns (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as SessionTurns;
}

/** POST `/sessions/:id/replay-from` — truncate history at `turn_index` and rerun. */
export async function replayFrom(
  id: string,
  turn_index: number,
  input?: string,
): Promise<ReplayResponse> {
  const body: { turn_index: number; input?: string } = { turn_index };
  if (input !== undefined) body.input = input;
  const res = await fetch(`/sessions/${encodeURIComponent(id)}/replay-from`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Replay failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as ReplayResponse;
}

/**
 * Fetch `GET /graph` from the same origin the studio is served from.
 *
 * Returns an empty graph on any error (server unreachable, malformed
 * payload, network blip). The caller polls on an interval, so transient
 * failures should not blow up the UI — they are simply absorbed into an
 * empty render until the next tick succeeds.
 */
export async function fetchGraph(signal?: AbortSignal): Promise<GraphPayload> {
  try {
    const res = await fetch("/graph", signal ? { signal } : {});
    if (!res.ok) return EMPTY;
    const data = (await res.json()) as Partial<GraphPayload>;
    return {
      ...(data.entrypoint !== undefined ? { entrypoint: data.entrypoint } : {}),
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
      ...(data.has_state !== undefined ? { has_state: data.has_state } : {}),
    };
  } catch {
    return EMPTY;
  }
}
