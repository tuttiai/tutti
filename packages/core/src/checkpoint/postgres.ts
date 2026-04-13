import pg from "pg";
import { logger } from "../logger.js";
import type { CheckpointStore } from "./store.js";
import type { Checkpoint } from "./types.js";
import { DEFAULT_CHECKPOINT_TTL_SECONDS } from "./redis.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_checkpoints";
/** How many most-recent turns to keep per session after every `save`. */
const KEEP_LAST_N_TURNS = 10;

// Table names can't be parameterised — validate against an allow-list
// before interpolating into SQL to keep the surface injection-proof.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

export interface PostgresCheckpointStoreOptions {
  /** Postgres connection string. */
  connection_string: string;
  /** Table name override. Default: `tutti_checkpoints`. */
  table?: string;
  /** Retention in seconds. Default: 604800 (7 days). */
  ttl_seconds?: number;
}

interface CheckpointRow {
  session_id: string;
  turn: number;
  data: Record<string, unknown>;
  saved_at: Date;
  expires_at: Date | null;
}

/**
 * Postgres-backed {@link CheckpointStore}.
 *
 * Schema (created on first use, idempotent):
 *
 *   CREATE TABLE tutti_checkpoints (
 *     session_id  TEXT        NOT NULL,
 *     turn        INTEGER     NOT NULL,
 *     data        JSONB       NOT NULL,
 *     saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     expires_at  TIMESTAMPTZ,
 *     PRIMARY KEY (session_id, turn)
 *   )
 *
 * Every `save` also deletes globally-expired rows and trims this session's
 * backlog to the {@link KEEP_LAST_N_TURNS} most-recent turns — cheap
 * house-keeping that keeps a single active session bounded even without a
 * background reaper.
 */
export class PostgresCheckpointStore implements CheckpointStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private readonly ttl: number;
  private ready: Promise<void> | undefined;

  constructor(options: PostgresCheckpointStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresCheckpointStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({ connectionString: options.connection_string });
    this.table = table;
    this.ttl = options.ttl_seconds ?? DEFAULT_CHECKPOINT_TTL_SECONDS;
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO " +
          this.table +
          " (session_id, turn, data, saved_at, expires_at) " +
          "VALUES ($1, $2, $3::jsonb, $4, NOW() + ($5 || ' seconds')::interval) " +
          "ON CONFLICT (session_id, turn) DO UPDATE SET " +
          "data = EXCLUDED.data, " +
          "saved_at = EXCLUDED.saved_at, " +
          "expires_at = EXCLUDED.expires_at",
        [
          checkpoint.session_id,
          checkpoint.turn,
          JSON.stringify(checkpoint),
          checkpoint.saved_at,
          String(this.ttl),
        ],
      );

      // 1. Global expiry sweep — cheap; touches at most a handful of rows
      //    in steady state because earlier saves already cleared them.
      await client.query(
        "DELETE FROM " +
          this.table +
          " WHERE expires_at IS NOT NULL AND expires_at < NOW()",
      );

      // 2. Per-session trim — keep only the KEEP_LAST_N_TURNS most recent
      //    rows for this session. The correlated subquery returns the
      //    cutoff turn; if fewer than N rows exist, no DELETE happens.
      await client.query(
        "DELETE FROM " +
          this.table +
          " WHERE session_id = $1 AND turn < (" +
          "  SELECT turn FROM " +
          this.table +
          "  WHERE session_id = $1" +
          "  ORDER BY turn DESC" +
          "  OFFSET $2 LIMIT 1" +
          ")",
        [checkpoint.session_id, KEEP_LAST_N_TURNS - 1],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async loadLatest(session_id: string): Promise<Checkpoint | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<CheckpointRow>(
      "SELECT session_id, turn, data, saved_at, expires_at FROM " +
        this.table +
        " WHERE session_id = $1 " +
        "  AND (expires_at IS NULL OR expires_at > NOW()) " +
        "ORDER BY turn DESC LIMIT 1",
      [session_id],
    );
    return rows.length > 0 ? rowToCheckpoint(rows[0]) : null;
  }

  async load(session_id: string, turn: number): Promise<Checkpoint | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<CheckpointRow>(
      "SELECT session_id, turn, data, saved_at, expires_at FROM " +
        this.table +
        " WHERE session_id = $1 AND turn = $2 " +
        "  AND (expires_at IS NULL OR expires_at > NOW())",
      [session_id, turn],
    );
    return rows.length > 0 ? rowToCheckpoint(rows[0]) : null;
  }

  async delete(session_id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "DELETE FROM " + this.table + " WHERE session_id = $1",
      [session_id],
    );
  }

  async list(session_id: string): Promise<Checkpoint[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<CheckpointRow>(
      "SELECT session_id, turn, data, saved_at, expires_at FROM " +
        this.table +
        " WHERE session_id = $1 " +
        "  AND (expires_at IS NULL OR expires_at > NOW()) " +
        "ORDER BY turn ASC",
      [session_id],
    );
    return rows.map(rowToCheckpoint);
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
          "  session_id TEXT NOT NULL, " +
          "  turn INTEGER NOT NULL, " +
          "  data JSONB NOT NULL, " +
          "  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
          "  expires_at TIMESTAMPTZ, " +
          "  PRIMARY KEY (session_id, turn)" +
          ")",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS " +
          this.table +
          "_session_idx ON " +
          this.table +
          " (session_id)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS " +
          this.table +
          "_expires_idx ON " +
          this.table +
          " (expires_at) WHERE expires_at IS NOT NULL",
      );
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "PostgresCheckpointStore: failed to create schema",
      );
      throw err;
    }
  }
}

/** Turn a raw Postgres row into a fully-typed Checkpoint. */
function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  // `data` was serialised by our save path and is known to carry the full
  // Checkpoint shape; rehydrate the Date fields that JSON stripped.
  const data = row.data;
  const savedAt = data.saved_at;
  return {
    ...data,
    saved_at:
      typeof savedAt === "string"
        ? new Date(savedAt)
        : savedAt instanceof Date
          ? savedAt
          : row.saved_at,
  } as Checkpoint;
}
