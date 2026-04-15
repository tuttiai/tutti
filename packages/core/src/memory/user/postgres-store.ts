import { randomUUID } from "node:crypto";
import pg from "pg";

import { logger } from "../../logger.js";
import type {
  StoreOptions,
  UserMemory,
  UserMemoryImportance,
  UserMemorySource,
  UserMemoryStore,
} from "./types.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_user_memories";
const DEFAULT_MAX_MEMORIES_PER_USER = 200;
// Table names can't be parameterised — validate against an allow-list
// before interpolating into SQL to keep the surface injection-proof.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

/** Construction options for {@link PostgresUserMemoryStore}. */
export interface PostgresUserMemoryStoreOptions {
  /** Postgres connection string. Typically read from `TUTTI_PG_URL`. */
  connection_string: string;
  /** Table name override. Default: `tutti_user_memories`. */
  table?: string;
  /** Per-user cap. Defaults to 200. Enforced after every {@link store}. */
  max_memories_per_user?: number;
}

interface UserMemoryRow {
  id: string;
  user_id: string;
  content: string;
  source: string;
  importance: number;
  tags: string[] | null;
  created_at: Date;
  last_accessed_at: Date | null;
  expires_at: Date | null;
}

/**
 * Postgres-backed {@link UserMemoryStore}.
 *
 * Schema (created on first use, idempotent):
 *
 * ```sql
 * CREATE TABLE tutti_user_memories (
 *   id               TEXT PRIMARY KEY,
 *   user_id          TEXT NOT NULL,
 *   content          TEXT NOT NULL,
 *   source           TEXT NOT NULL,
 *   importance       INT  DEFAULT 2,
 *   tags             TEXT[],
 *   created_at       TIMESTAMPTZ DEFAULT NOW(),
 *   last_accessed_at TIMESTAMPTZ,
 *   expires_at       TIMESTAMPTZ
 * );
 * CREATE INDEX idx_user_memories_user_id ON tutti_user_memories(user_id);
 * ```
 *
 * Search uses the `pg_trgm` `%` operator + `similarity()` ranking when
 * the extension is available; falls back to `ILIKE '%q%'` otherwise. The
 * detection runs once at first use and is cached for the lifetime of
 * the store.
 *
 * Every {@link store} call fires (and does not await) a sweep that
 * deletes globally-expired rows, so callers don't pay the round-trip
 * cost on the hot path.
 */
export class PostgresUserMemoryStore implements UserMemoryStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private readonly maxMemoriesPerUser: number;
  private ready: Promise<void> | undefined;
  private trigramAvailable = false;

  constructor(options: PostgresUserMemoryStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresUserMemoryStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({ connectionString: options.connection_string });
    this.table = table;
    this.maxMemoriesPerUser =
      options.max_memories_per_user ?? DEFAULT_MAX_MEMORIES_PER_USER;
  }

  async store(
    user_id: string,
    content: string,
    options: StoreOptions = {},
  ): Promise<UserMemory> {
    await this.ensureSchema();

    const id = randomUUID();
    const source: UserMemorySource = options.source ?? "explicit";
    const importance: UserMemoryImportance = options.importance ?? 2;
    const tags = options.tags ?? null;
    const expires_at = options.expires_at ?? null;

    const result = await this.pool.query<UserMemoryRow>(
      "INSERT INTO " +
        this.table +
        " (id, user_id, content, source, importance, tags, expires_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7) " +
        "RETURNING id, user_id, content, source, importance, tags, " +
        "created_at, last_accessed_at, expires_at",
      [id, user_id, content, source, importance, tags, expires_at],
    );

    // Background housekeeping — fire-and-forget so the hot path stays fast.
    void this.sweepExpired();
    void this.enforceCap(user_id);

    return rowToMemory(result.rows[0]!);
  }

  async search(
    user_id: string,
    query: string,
    limit = 10,
  ): Promise<UserMemory[]> {
    await this.ensureSchema();
    const trimmed = query.trim();
    if (trimmed === "") return [];

    const sql = this.trigramAvailable
      ? "SELECT id, user_id, content, source, importance, tags, " +
        "created_at, last_accessed_at, expires_at " +
        "FROM " + this.table + " " +
        "WHERE user_id = $1 " +
        "AND (expires_at IS NULL OR expires_at > NOW()) " +
        "AND content % $2 " +
        "ORDER BY similarity(content, $2) DESC, importance DESC, created_at DESC " +
        "LIMIT $3"
      : "SELECT id, user_id, content, source, importance, tags, " +
        "created_at, last_accessed_at, expires_at " +
        "FROM " + this.table + " " +
        "WHERE user_id = $1 " +
        "AND (expires_at IS NULL OR expires_at > NOW()) " +
        "AND content ILIKE '%' || $2 || '%' " +
        "ORDER BY importance DESC, created_at DESC " +
        "LIMIT $3";

    const result = await this.pool.query<UserMemoryRow>(sql, [user_id, trimmed, limit]);

    if (result.rows.length > 0) {
      const ids = result.rows.map((r) => r.id);
      // Bump last_accessed_at on every hit. Atomic enough — readers don't
      // care about the precise nanosecond and writers serialise on PK.
      await this.pool.query(
        "UPDATE " + this.table + " SET last_accessed_at = NOW() WHERE id = ANY($1::text[])",
        [ids],
      );
    }

    return result.rows.map(rowToMemory);
  }

  async list(user_id: string): Promise<UserMemory[]> {
    await this.ensureSchema();
    const result = await this.pool.query<UserMemoryRow>(
      "SELECT id, user_id, content, source, importance, tags, " +
        "created_at, last_accessed_at, expires_at " +
        "FROM " + this.table + " " +
        "WHERE user_id = $1 " +
        "AND (expires_at IS NULL OR expires_at > NOW()) " +
        "ORDER BY created_at DESC",
      [user_id],
    );
    return result.rows.map(rowToMemory);
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    // No-op when the id is unknown — interface contract is idempotent.
    await this.pool.query("DELETE FROM " + this.table + " WHERE id = $1", [id]);
  }

  async deleteAll(user_id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("DELETE FROM " + this.table + " WHERE user_id = $1", [user_id]);
  }

  async get(id: string): Promise<UserMemory | null> {
    await this.ensureSchema();
    const result = await this.pool.query<UserMemoryRow>(
      "SELECT id, user_id, content, source, importance, tags, " +
        "created_at, last_accessed_at, expires_at " +
        "FROM " + this.table + " " +
        "WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW())",
      [id],
    );
    if (result.rows.length === 0) return null;
    // Bump last_accessed_at on the hit.
    await this.pool.query(
      "UPDATE " + this.table + " SET last_accessed_at = NOW() WHERE id = $1",
      [id],
    );
    return rowToMemory(result.rows[0]!);
  }

  /** Close the connection pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Ensure the schema exists and the trigram-availability probe has run.
   * Idempotent — every operation awaits the same memoised promise.
   */
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
        "user_id TEXT NOT NULL, " +
        "content TEXT NOT NULL, " +
        "source TEXT NOT NULL, " +
        "importance INT DEFAULT 2, " +
        "tags TEXT[], " +
        "created_at TIMESTAMPTZ DEFAULT NOW(), " +
        "last_accessed_at TIMESTAMPTZ, " +
        "expires_at TIMESTAMPTZ" +
        ")",
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS idx_" + this.table + "_user_id " +
        "ON " + this.table + "(user_id)",
    );

    // Probe pg_trgm. Don't fail on probe error — fall back to ILIKE.
    try {
      const probe = await this.pool.query<{ has: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has",
      );
      this.trigramAvailable = probe.rows[0]?.has === true;
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "PostgresUserMemoryStore: pg_trgm probe failed — falling back to ILIKE",
      );
      this.trigramAvailable = false;
    }
  }

  /** Delete every row past its expires_at. Errors are logged, not thrown. */
  private async sweepExpired(): Promise<void> {
    try {
      await this.pool.query(
        "DELETE FROM " + this.table +
          " WHERE expires_at IS NOT NULL AND expires_at < NOW()",
      );
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "PostgresUserMemoryStore: expired-row sweep failed",
      );
    }
  }

  /**
   * Trim the user's row count back to {@link maxMemoriesPerUser},
   * keeping the highest-importance + most-recent rows. Errors logged
   * not thrown — eviction is best-effort.
   */
  private async enforceCap(user_id: string): Promise<void> {
    try {
      await this.pool.query(
        "DELETE FROM " + this.table + " WHERE user_id = $1 AND id NOT IN (" +
          "SELECT id FROM " + this.table + " " +
          "WHERE user_id = $1 " +
          "ORDER BY importance DESC, created_at DESC " +
          "LIMIT $2" +
          ")",
        [user_id, this.maxMemoriesPerUser],
      );
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          user_id,
        },
        "PostgresUserMemoryStore: cap enforcement failed",
      );
    }
  }
}

function rowToMemory(row: UserMemoryRow): UserMemory {
  // exactOptionalPropertyTypes-friendly construction: omit absent fields
  // entirely rather than setting them to undefined.
  const memory: UserMemory = {
    id: row.id,
    user_id: row.user_id,
    content: row.content,
    source: row.source as UserMemorySource,
    importance: row.importance as UserMemoryImportance,
    created_at: row.created_at,
  };
  if (row.tags !== null) memory.tags = row.tags;
  if (row.last_accessed_at !== null) memory.last_accessed_at = row.last_accessed_at;
  if (row.expires_at !== null) memory.expires_at = row.expires_at;
  return memory;
}
