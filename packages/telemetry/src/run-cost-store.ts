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
 * Persistence contract for {@link RunCostRecord}s.
 *
 * Implementations MUST:
 * - treat `record` as append-only — re-recording the same `run_id` is
 *   undefined behaviour; the runtime never does it;
 * - return the sum of `cost_usd` across every record with
 *   `started_at >= since` from `sumSince`, or `0` when none match;
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
