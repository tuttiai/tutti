import pg from "pg";
import { logger } from "../logger.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleRecord, ScheduledRun } from "./types.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_schedules";
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

export interface PostgresScheduleStoreOptions {
  /** Postgres connection string. */
  connection_string: string;
  /** Table name override. Default: `tutti_schedules`. */
  table?: string;
}

interface ScheduleRow {
  id: string;
  agent_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
  next_run_at: Date | null;
  run_count: number;
}

/**
 * Postgres-backed {@link ScheduleStore}.
 *
 * Schema (created on first use, idempotent):
 *
 *   CREATE TABLE tutti_schedules (
 *     id          TEXT        PRIMARY KEY,
 *     agent_id    TEXT        NOT NULL,
 *     config      JSONB       NOT NULL,
 *     enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
 *     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     next_run_at TIMESTAMPTZ,
 *     run_count   INTEGER     NOT NULL DEFAULT 0
 *   )
 */
export class PostgresScheduleStore implements ScheduleStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private ready: Promise<void> | undefined;

  constructor(options: PostgresScheduleStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresScheduleStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({ connectionString: options.connection_string });
    this.table = table;
  }

  async save(record: ScheduleRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO " + this.table +
        " (id, agent_id, config, enabled, created_at, next_run_at, run_count)" +
        " VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)" +
        " ON CONFLICT (id) DO UPDATE SET" +
        "   config = EXCLUDED.config," +
        "   enabled = EXCLUDED.enabled," +
        "   next_run_at = EXCLUDED.next_run_at," +
        "   run_count = EXCLUDED.run_count",
      [
        record.id,
        record.agent_id,
        JSON.stringify(record.config),
        record.enabled,
        record.created_at,
        record.next_run_at ?? null,
        record.run_count,
      ],
    );
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<ScheduleRow>(
      "SELECT * FROM " + this.table + " WHERE id = $1",
      [id],
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async list(): Promise<ScheduleRecord[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<ScheduleRow>(
      "SELECT * FROM " + this.table + " ORDER BY created_at ASC",
    );
    return rows.map(rowToRecord);
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "DELETE FROM " + this.table + " WHERE id = $1",
      [id],
    );
  }

  async addRun(id: string, run: ScheduledRun): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "UPDATE " + this.table + " SET run_count = run_count + 1 WHERE id = $1",
      [id],
    );
    // Runs are logged via the event bus — we only track run_count in the
    // schedule record itself. A dedicated tutti_schedule_runs table could
    // be added later if full run history is needed.
    void run;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "UPDATE " + this.table + " SET enabled = $1 WHERE id = $2",
      [enabled, id],
    );
  }

  /** Release the underlying pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private ensureSchema(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.runSchema().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async runSchema(): Promise<void> {
    try {
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS " + this.table + " (" +
          "  id TEXT PRIMARY KEY," +
          "  agent_id TEXT NOT NULL," +
          "  config JSONB NOT NULL," +
          "  enabled BOOLEAN NOT NULL DEFAULT TRUE," +
          "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()," +
          "  next_run_at TIMESTAMPTZ," +
          "  run_count INTEGER NOT NULL DEFAULT 0" +
          ")",
      );
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "PostgresScheduleStore: failed to create schema",
      );
      throw err;
    }
  }
}

function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    agent_id: row.agent_id,
    config: row.config as unknown as ScheduleRecord["config"],
    enabled: row.enabled,
    created_at: row.created_at,
    next_run_at: row.next_run_at ?? undefined,
    run_count: row.run_count,
  };
}
