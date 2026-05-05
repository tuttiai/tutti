/**
 * Persistent record of one completed agent run's cost. Written by
 * `AgentRunner` at the end of every run; read at the start of the next
 * run when daily/monthly budget enforcement is enabled.
 *
 * Kept deliberately narrow — daily/monthly aggregation only needs the
 * timestamp and the dollar figure. Tokens are recorded for audit but
 * not used in budget arithmetic.
 */
export interface RunCostRecord {
  /**
   * Unique identifier for this run. Callers typically pass the
   * `trace_id`; the store does not enforce any particular shape.
   */
  run_id: string;
  /** Agent that produced the run, for grouping and ad-hoc inspection. */
  agent_name: string;
  /** When the run started. Used for daily/monthly bucketing. */
  started_at: Date;
  /** Aggregate USD cost across every LLM call in the run. */
  cost_usd: number;
  /** Aggregate token count across every LLM call in the run. */
  total_tokens: number;
}

/**
 * Filter / sort / pagination knobs for {@link RunCostStore.list}.
 *
 * Filtering composes with AND semantics — a record is included only when
 * every constraint matches. Order defaults to most-recent-first because
 * that's what the CLI's `analyze` and `report` commands display.
 */
export interface RunCostQuery {
  /** Only include records with `started_at >= since`. */
  since?: Date;
  /** Only include records with `started_at < until`. Half-open. */
  until?: Date;
  /** Only include records with this `agent_name`. */
  agent_name?: string;
  /** Maximum rows to return. Implementations MUST honour this. */
  limit?: number;
  /** Sort order. `"desc"` (default) returns most-recent first. */
  order?: "asc" | "desc";
}

/**
 * Persistence contract for {@link RunCostRecord}s.
 *
 * Implementations MUST:
 * - treat `record` as append-only — re-recording the same `run_id` is
 *   undefined behaviour; the runtime never does it;
 * - return the sum of `cost_usd` across every record with
 *   `started_at >= since` from `sumSince`, or `0` when none match;
 * - return matching records from `list`, applying every constraint with
 *   AND semantics, sorted by `started_at` per the `order` knob, and
 *   honouring `limit` if supplied;
 * - never throw on transient backend issues — log and degrade to `0`
 *   so a flaky cost store cannot block agent runs (the `record` path
 *   may throw; the budget path swallows by reading `0` and emitting
 *   the underlying error to the runtime logger).
 */
export interface RunCostStore {
  /** Append one run's cost to the store. */
  record(r: RunCostRecord): Promise<void>;
  /** Sum `cost_usd` across every record with `started_at >= since`. */
  sumSince(since: Date): Promise<number>;
  /** Return records matching `query`, sorted by `started_at`. */
  list(query?: RunCostQuery): Promise<RunCostRecord[]>;
}

/**
 * Zero-config in-memory backend. Suitable for development, tests, and
 * single-process deployments where losing history on restart is
 * acceptable. For multi-process deployments use
 * `PostgresRunCostStore` so every worker sees the same daily total.
 */
export class InMemoryRunCostStore implements RunCostStore {
  private readonly records: RunCostRecord[] = [];

  record(r: RunCostRecord): Promise<void> {
    // Defensive copy — caller mutating `started_at` after the call
    // shouldn't shift our bucketing.
    this.records.push({ ...r, started_at: new Date(r.started_at) });
    return Promise.resolve();
  }

  sumSince(since: Date): Promise<number> {
    const cutoff = since.getTime();
    let total = 0;
    for (const r of this.records) {
      if (r.started_at.getTime() >= cutoff) total += r.cost_usd;
    }
    return Promise.resolve(total);
  }

  list(query: RunCostQuery = {}): Promise<RunCostRecord[]> {
    const since = query.since?.getTime();
    const until = query.until?.getTime();
    const agent = query.agent_name;
    const filtered = this.records.filter((r) => {
      const t = r.started_at.getTime();
      if (since !== undefined && t < since) return false;
      if (until !== undefined && t >= until) return false;
      if (agent !== undefined && r.agent_name !== agent) return false;
      return true;
    });
    const order = query.order ?? "desc";
    filtered.sort((a, b) =>
      order === "asc"
        ? a.started_at.getTime() - b.started_at.getTime()
        : b.started_at.getTime() - a.started_at.getTime(),
    );
    // Defensive copies so callers can't mutate stored timestamps.
    const trimmed =
      query.limit !== undefined ? filtered.slice(0, Math.max(0, query.limit)) : filtered;
    return Promise.resolve(trimmed.map((r) => ({ ...r, started_at: new Date(r.started_at) })));
  }

  /**
   * Test helper — drop every record. Not part of the public
   * {@link RunCostStore} contract because production callers never
   * need it.
   */
  reset(): void {
    this.records.length = 0;
  }
}

/**
 * Return the start of the UTC day containing `now`. Exported for use by
 * the runtime and tests; using UTC means daily/monthly windows behave
 * identically across deployment regions.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Return the start of the UTC calendar month containing `now`. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Sum `cost_usd` across every run that started on or after the start
 * of the current UTC day. Callers pass the runtime's
 * {@link RunCostStore}; tests can pin `now` to a fixed clock.
 */
export function getDailyCost(
  store: RunCostStore,
  now: Date = new Date(),
): Promise<number> {
  return store.sumSince(startOfUtcDay(now));
}

/**
 * Sum `cost_usd` across every run that started on or after the first
 * of the current UTC calendar month.
 */
export function getMonthlyCost(
  store: RunCostStore,
  now: Date = new Date(),
): Promise<number> {
  return store.sumSince(startOfUtcMonth(now));
}
