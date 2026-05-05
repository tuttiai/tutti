import type { TuttiRuntime } from "@tuttiai/core";

/**
 * One row returned by `GET /sessions`. Snake_case to match the rest of
 * the HTTP wire shape.
 */
export interface SessionSummary {
  id: string;
  started_at: string;
  status: "running" | "complete" | "error";
  turn_count: number;
  model: string;
  agent_name: string;
}

/**
 * In-memory directory of sessions seen by this server process.
 *
 * The {@link SessionStore} interface in `@tuttiai/types` only supports
 * `create` / `get` / `update` — it has no `list()`. Rather than widen
 * that public contract, the registry shadows the data we need by
 * subscribing to `runtime.events`'s `agent:start` / `agent:end` /
 * `agent:error` channels.
 *
 * In graph mode the engine creates a fresh agent session per node, so
 * the registry surfaces those per-node sessions (rather than the
 * graph's top-level event-only `session_id` which has no `Session`
 * record behind it). This means the studio's history list shows the
 * conversations the user can actually inspect and replay.
 *
 * The registry only knows about sessions that happened during the
 * current server lifetime; older sessions in a Postgres store would
 * need a separate persistence layer (out of scope for this step).
 */
export class SessionsRegistry {
  private readonly entries = new Map<string, SessionSummary>();
  private readonly runtime: TuttiRuntime;
  private readonly subscriptions: (() => void)[] = [];

  constructor(runtime: TuttiRuntime) {
    this.runtime = runtime;
    this.attach();
  }

  /**
   * Snapshot of every session we've seen, sorted most-recent first.
   *
   * `turn_count` is read live from the runtime's session store on each
   * call so navigating from the studio shows the up-to-date count
   * (older snapshots could be stale otherwise).
   */
  list(): SessionSummary[] {
    const rows = [...this.entries.values()].map((row) => {
      const session = this.runtime.getSession(row.id);
      return {
        ...row,
        turn_count: session?.messages.length ?? row.turn_count,
      };
    });
    rows.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    return rows;
  }

  /** Tear down event subscriptions (called from the server's close hook). */
  close(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  // ── internals ──────────────────────────────────────────────

  private attach(): void {
    // Always track agent sessions — they're the unit of conversation
    // that has actual messages we can inspect and replay. Graph mode
    // creates one agent session per node visit, all of which are
    // surfaced here.
    this.subscriptions.push(
      this.runtime.events.on("agent:start", (event) => {
        this.upsert(
          event.session_id,
          "running",
          event.agent_name,
          this.agentModel(event.agent_name),
        );
      }),
    );
    this.subscriptions.push(
      this.runtime.events.on("agent:end", (event) => {
        this.markStatus(event.session_id, "complete");
      }),
    );
    // Graph-node agents aren't in `score.agents`, so the model lookup
    // above falls back to `default_model`. Catch the real model from
    // `llm:request` events — they carry the resolved model name. We
    // can't tie an `llm:request` to a session_id directly, so this is
    // best-effort: every running session gets its `model` updated to
    // the most recently seen request, which is correct in single-run
    // conditions and harmless under concurrency.
    this.subscriptions.push(
      this.runtime.events.on("llm:request", (event) => {
        const model = event.request.model;
        if (typeof model !== "string" || model.length === 0) return;
        for (const row of this.entries.values()) {
          if (row.agent_name === event.agent_name && row.status === "running") {
            row.model = model;
          }
        }
      }),
    );
  }

  private upsert(
    id: string,
    status: SessionSummary["status"],
    agentName: string,
    model: string,
  ): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.status = status;
      return;
    }
    this.entries.set(id, {
      id,
      started_at: new Date().toISOString(),
      status,
      turn_count: 0,
      model,
      agent_name: agentName,
    });
  }

  private markStatus(id: string, status: SessionSummary["status"]): void {
    const row = this.entries.get(id);
    if (row) row.status = status;
  }

  private agentModel(agentName: string): string {
    const score = this.runtime.score;
    // `agentName` flows from a TuttiEvent the runtime itself emitted —
    // it always identifies a real agent key (or a graph-node agent
    // that legitimately falls through to default_model).
    // eslint-disable-next-line security/detect-object-injection
    const agent = score.agents[agentName];
    return agent?.model ?? score.default_model ?? "unknown";
  }
}
