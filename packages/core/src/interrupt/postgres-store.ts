import { randomUUID } from "node:crypto";
import pg from "pg";

import type { InterruptStore } from "./store.js";
import type {
  InterruptCreateInput,
  InterruptRequest,
  InterruptStatus,
  ResolveOptions,
} from "./types.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_interrupts";
// Table names can't be parameterised — validate against an allow-list
// before interpolating into SQL to keep the surface injection-proof.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

/** Construction options for {@link PostgresInterruptStore}. */
export interface PostgresInterruptStoreOptions {
  /** Postgres connection string. Typically read from `TUTTI_PG_URL`. */
  connection_string: string;
  /** Table name override. Default: `tutti_interrupts`. */
  table?: string;
}

interface InterruptRow {
  id: string;
  session_id: string;
  tool_name: string;
  tool_args: unknown;
  status: string;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  denial_reason: string | null;
}

/**
 * Postgres-backed {@link InterruptStore}.
 *
 * Schema (created on first use, idempotent):
 *
 * ```sql
 * CREATE TABLE tutti_interrupts (
 *   id             TEXT PRIMARY KEY,
 *   session_id     TEXT NOT NULL,
 *   tool_name      TEXT NOT NULL,
 *   tool_args      JSONB NOT NULL,
 *   status         TEXT NOT NULL DEFAULT 'pending',
 *   requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   resolved_at    TIMESTAMPTZ,
 *   resolved_by    TEXT,
 *   denial_reason  TEXT
 * );
 * CREATE INDEX idx_tutti_interrupts_pending
 *   ON tutti_interrupts(session_id, requested_at)
 *   WHERE status = 'pending';
 * ```
 *
 * The partial index keeps `listPending()` fast even as the history of
 * resolved requests grows — reviews tend to run in bursts, so the
 * pending set stays small.
 */
export class PostgresInterruptStore implements InterruptStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private ready: Promise<void> | undefined;

  constructor(options: PostgresInterruptStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresInterruptStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({ connectionString: options.connection_string });
    this.table = table;
  }

  async create(input: InterruptCreateInput): Promise<InterruptRequest> {
    await this.ensureSchema();
    const id = randomUUID();
    const result = await this.pool.query<InterruptRow>(
      "INSERT INTO " + this.table +
        " (id, session_id, tool_name, tool_args, status) " +
        "VALUES ($1, $2, $3, $4::jsonb, 'pending') " +
        "RETURNING id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason",
      [id, input.session_id, input.tool_name, JSON.stringify(input.tool_args)],
    );
    return rowToRequest(result.rows[0]!);
  }

  async get(interrupt_id: string): Promise<InterruptRequest | null> {
    await this.ensureSchema();
    const result = await this.pool.query<InterruptRow>(
      "SELECT id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason " +
        "FROM " + this.table + " WHERE id = $1",
      [interrupt_id],
    );
    if (result.rows.length === 0) return null;
    return rowToRequest(result.rows[0]!);
  }

  async resolve(
    interrupt_id: string,
    status: "approved" | "denied",
    options: ResolveOptions = {},
  ): Promise<InterruptRequest> {
    await this.ensureSchema();
    // Idempotent: only transition rows that are still pending. The
    // RETURNING clause gives us the post-update row so we can detect a
    // no-op by comparing row counts against a fallback SELECT.
    const update = await this.pool.query<InterruptRow>(
      "UPDATE " + this.table + " " +
        "SET status = $2, resolved_at = NOW(), resolved_by = $3, denial_reason = $4 " +
        "WHERE id = $1 AND status = 'pending' " +
        "RETURNING id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason",
      [interrupt_id, status, options.resolved_by ?? null, options.denial_reason ?? null],
    );

    if (update.rows.length > 0) {
      return rowToRequest(update.rows[0]!);
    }

    // Either the row doesn't exist or it was already resolved. Read it
    // back to tell the two cases apart.
    const existing = await this.get(interrupt_id);
    if (!existing) {
      throw new Error(
        "PostgresInterruptStore: unknown interrupt_id " + interrupt_id,
      );
    }
    return existing; // already-resolved record, returned unchanged
  }

  async listPending(session_id?: string): Promise<InterruptRequest[]> {
    await this.ensureSchema();
    const sql = session_id
      ? "SELECT id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason " +
        "FROM " + this.table + " " +
        "WHERE status = 'pending' AND session_id = $1 " +
        "ORDER BY requested_at ASC"
      : "SELECT id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason " +
        "FROM " + this.table + " " +
        "WHERE status = 'pending' " +
        "ORDER BY requested_at ASC";
    const params = session_id ? [session_id] : [];
    const result = await this.pool.query<InterruptRow>(sql, params);
    return result.rows.map(rowToRequest);
  }

  async listBySession(session_id: string): Promise<InterruptRequest[]> {
    await this.ensureSchema();
    const result = await this.pool.query<InterruptRow>(
      "SELECT id, session_id, tool_name, tool_args, status, " +
        "requested_at, resolved_at, resolved_by, denial_reason " +
        "FROM " + this.table + " " +
        "WHERE session_id = $1 " +
        "ORDER BY requested_at ASC",
      [session_id],
    );
    return result.rows.map(rowToRequest);
  }

  /** Close the connection pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.bootstrap();
    }
    return this.ready;
  }

  private async bootstrap(): Promise<void> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS " + this.table + " (" +
        "id TEXT PRIMARY KEY, " +
        "session_id TEXT NOT NULL, " +
        "tool_name TEXT NOT NULL, " +
        "tool_args JSONB NOT NULL, " +
        "status TEXT NOT NULL DEFAULT 'pending', " +
        "requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
        "resolved_at TIMESTAMPTZ, " +
        "resolved_by TEXT, " +
        "denial_reason TEXT" +
        ")",
    );
    // Partial index on the pending set — review queues poll this
    // often, and the resolved history can grow without bound.
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS idx_" + this.table + "_pending " +
        "ON " + this.table + "(session_id, requested_at) " +
        "WHERE status = 'pending'",
    );
  }
}

function rowToRequest(row: InterruptRow): InterruptRequest {
  const req: InterruptRequest = {
    interrupt_id: row.id,
    session_id: row.session_id,
    tool_name: row.tool_name,
    tool_args: row.tool_args,
    requested_at: row.requested_at,
    status: row.status as InterruptStatus,
  };
  if (row.resolved_at !== null) req.resolved_at = row.resolved_at;
  if (row.resolved_by !== null) req.resolved_by = row.resolved_by;
  if (row.denial_reason !== null) req.denial_reason = row.denial_reason;
  return req;
}
