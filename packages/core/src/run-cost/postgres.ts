import pg from "pg";
import type { RunCostQuery, RunCostRecord, RunCostStore } from "@tuttiai/telemetry";
import { logger } from "../logger.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_run_costs";
/** Drop records older than this on every `record` call. Default 90 days. */
const DEFAULT_RETENTION_DAYS = 90;

// Table names cannot be parameterised — validate against an allow-list
// before interpolating into SQL to keep the surface injection-proof.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

export interface PostgresRunCostStoreOptions {
  /** Postgres connection string. */
  connection_string: string;
  /** Table name override. Default: `tutti_run_costs`. */
  table?: string;
  /** Retention in days. Records older than this are deleted on each
   *  `record` call. Default: 90. Daily/monthly windows still work
   *  because 90 days easily covers a calendar month. */
  retention_days?: number;
}

/**
 * Postgres-backed {@link RunCostStore}.
 *
 * Schema (created on first use, idempotent):
 *
 *   CREATE TABLE tutti_run_costs (
 *     run_id        TEXT        PRIMARY KEY,
 *     agent_name    TEXT        NOT NULL,
 *     started_at    TIMESTAMPTZ NOT NULL,
 *     cost_usd      NUMERIC(20, 10) NOT NULL,
 *     total_tokens  BIGINT      NOT NULL DEFAULT 0
 *   )
 *
 * Indexed on `started_at` so daily/monthly aggregation queries run as
 * a fast range scan rather than a full table scan.
 *
 * Every `record` call also deletes rows older than `retention_days` —
 * cheap house-keeping that bounds table size without a background
 * reaper. Daily/monthly windows still work because 90 days covers the
 * widest standard window (a calendar month) with margin.
 */
export class PostgresRunCostStore implements RunCostStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private readonly retentionDays: number;
  private ready: Promise<void> | undefined;

  constructor(options: PostgresRunCostStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresRunCostStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({ connectionString: options.connection_string });
    this.table = table;
    this.retentionDays = options.retention_days ?? DEFAULT_RETENTION_DAYS;
  }

  async record(r: RunCostRecord): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO " +
          this.table +
          " (run_id, agent_name, started_at, cost_usd, total_tokens) " +
          "VALUES ($1, $2, $3, $4, $5) " +
          "ON CONFLICT (run_id) DO NOTHING",
        [r.run_id, r.agent_name, r.started_at, r.cost_usd, r.total_tokens],
      );
      // Retention sweep — bounded delete; in steady state earlier writes
      // already cleared old rows, so this touches almost nothing.
      await client.query(
        "DELETE FROM " +
          this.table +
          " WHERE started_at < NOW() - ($1 || ' days')::interval",
        [String(this.retentionDays)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async sumSince(since: Date): Promise<number> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ total: string | null }>(
      "SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM " +
        this.table +
        " WHERE started_at >= $1",
      [since],
    );
    const raw = rows[0]?.total ?? "0";
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async list(query: RunCostQuery = {}): Promise<RunCostRecord[]> {
    await this.ensureSchema();
    // Build the WHERE clause dynamically while keeping every value
    // parameterised — `$N` placeholders only, no string interpolation.
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.since !== undefined) {
      params.push(query.since);
      where.push("started_at >= $" + params.length);
    }
    if (query.until !== undefined) {
      params.push(query.until);
      where.push("started_at < $" + params.length);
    }
    if (query.agent_name !== undefined) {
      params.push(query.agent_name);
      where.push("agent_name = $" + params.length);
    }
    const whereSql = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
    const orderSql = (query.order ?? "desc") === "asc" ? " ASC" : " DESC";
    let limitSql = "";
    if (query.limit !== undefined) {
      params.push(Math.max(0, query.limit));
      limitSql = " LIMIT $" + params.length;
    }
    const sql =
      "SELECT run_id, agent_name, started_at, cost_usd::text AS cost_usd, total_tokens FROM " +
      this.table +
      whereSql +
      " ORDER BY started_at" +
      orderSql +
      limitSql;
    const { rows } = await this.pool.query<{
      run_id: string;
      agent_name: string;
      started_at: Date;
      cost_usd: string;
      total_tokens: string | number;
    }>(sql, params);
    return rows.map((r) => ({
      run_id: r.run_id,
      agent_name: r.agent_name,
      started_at: r.started_at,
      cost_usd: Number(r.cost_usd),
      total_tokens: typeof r.total_tokens === "string" ? Number(r.total_tokens) : r.total_tokens,
    }));
  }

  /** Release the underlying pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Install the schema lazily on first use. */
  private ensureSchema(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.runSchema().catch((err: unknown) => {
      // Unset on failure so the next call retries — a transient outage
      // shouldn't permanently poison the store.
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async runSchema(): Promise<void> {
    try {
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS " +
          this.table +
          " (" +
          "  run_id TEXT PRIMARY KEY, " +
          "  agent_name TEXT NOT NULL, " +
          "  started_at TIMESTAMPTZ NOT NULL, " +
          "  cost_usd NUMERIC(20, 10) NOT NULL, " +
          "  total_tokens BIGINT NOT NULL DEFAULT 0" +
          ")",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS " +
          this.table +
          "_started_at_idx ON " +
          this.table +
          " (started_at)",
      );
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "PostgresRunCostStore: failed to create schema",
      );
      throw err;
    }
  }
}
