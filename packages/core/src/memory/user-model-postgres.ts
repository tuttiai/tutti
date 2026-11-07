/** Postgres-backed {@link UserModelStore}: one row per `user_id`. @module */

import pg from "pg";
import { z } from "zod";

import type { UserModelStore, UserProfile } from "./user-model.js";

const { Pool } = pg;

const DEFAULT_TABLE = "tutti_user_profiles";
// Bounds how long a call waits for a connection, so a call against an
// unreachable server rejects instead of hanging.
const CONNECTION_TIMEOUT_MS = 10_000;
// Table names can't be parameterised: validate against an allow-list
// before interpolating into SQL to keep the surface injection-proof.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
const COLUMNS =
  "user_id, summary, preferences, ongoing_projects, turn_count, last_consolidated_turn";
// Two processes racing `CREATE TABLE IF NOT EXISTS` can collide on the
// catalogue insert. The table exists once the other one commits, so these
// codes (unique_violation, duplicate_table) mean the bootstrap succeeded.
const CREATE_RACE_CODES = new Set(["23505", "42P07"]);

/** Construction options for {@link PostgresUserModelStore}. */
export interface PostgresUserModelStoreOptions {
  /**
   * Postgres connection string, typically
   * `SecretsManager.require("TUTTI_PG_URL")`. Never logged or put in an error.
   */
  connection_string: string;
  /**
   * Table name override. Must match `/^[a-z_][a-z0-9_]*$/i`.
   * Default: `tutti_user_profiles`.
   */
  table?: string;
}

const ProfileRowSchema = z.object({
  user_id: z.string(),
  summary: z.string(),
  preferences: z.record(z.string(), z.string()),
  ongoing_projects: z.array(z.string()),
  turn_count: z.number().int(),
  last_consolidated_turn: z.number().int(),
});

/**
 * Postgres-backed {@link UserModelStore}. Profiles survive a restart and
 * are shared by every process that points at the same database.
 *
 * Schema (created on first use, idempotent):
 *
 * ```sql
 * CREATE TABLE tutti_user_profiles (
 *   user_id                TEXT PRIMARY KEY,
 *   summary                TEXT NOT NULL DEFAULT '',
 *   preferences            JSONB NOT NULL DEFAULT '{}',
 *   ongoing_projects       TEXT[] NOT NULL DEFAULT '{}',
 *   turn_count             INTEGER NOT NULL DEFAULT 0,
 *   last_consolidated_turn INTEGER NOT NULL DEFAULT 0,
 *   updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * ```
 *
 * Behaves like {@link InMemoryUserModelStore}: `upsert` replaces the whole
 * record and the last write wins, `summary` is stored as given (the
 * consolidator caps it, not the store), and every call returns fresh
 * objects. Postgres errors reach the caller unchanged.
 *
 * Limits:
 * - Postgres rejects the NUL character (`\u0000`) in TEXT and JSONB, so a
 *   profile containing one is refused with the driver's error.
 * - Counters are 32-bit `INTEGER`s.
 * - The consolidator reads, changes and writes a profile back, so two
 *   concurrent runs for one user can lose a `turn_count` increment. The
 *   in-memory store has the same limit.
 *
 * @example
 * ```ts
 * runtime.setUserModelStore(
 *   "assistant",
 *   new PostgresUserModelStore({
 *     connection_string: SecretsManager.require("TUTTI_PG_URL"),
 *   }),
 * );
 * ```
 */
export class PostgresUserModelStore implements UserModelStore {
  private readonly pool: InstanceType<typeof Pool>;
  private readonly table: string;
  private ready: Promise<void> | undefined;

  /**
   * Create the store. Opens no connection until the first call.
   *
   * @throws Error when `options.table` is not a valid SQL identifier.
   */
  constructor(options: PostgresUserModelStoreOptions) {
    const table = options.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PostgresUserModelStore: table '" + table + "' is not a valid identifier",
      );
    }
    this.pool = new Pool({
      connectionString: options.connection_string,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    });
    this.table = table;
  }

  /** Read the profile for `user_id`, or `null` when there is none. */
  async get(user_id: string): Promise<UserProfile | null> {
    await this.ensureSchema();
    const result = await this.pool.query<Record<string, unknown>>(
      "SELECT " + COLUMNS + " FROM " + this.table + " WHERE user_id = $1",
      [user_id],
    );
    if (result.rows.length === 0) return null;
    return ProfileRowSchema.parse(result.rows[0]);
  }

  /** Write the whole profile, replacing any existing row for its `user_id`. */
  async upsert(profile: UserProfile): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO " + this.table + " (" + COLUMNS + ") " +
        "VALUES ($1, $2, $3::jsonb, $4::text[], $5, $6) " +
        "ON CONFLICT (user_id) DO UPDATE SET " +
        "summary = EXCLUDED.summary, " +
        "preferences = EXCLUDED.preferences, " +
        "ongoing_projects = EXCLUDED.ongoing_projects, " +
        "turn_count = EXCLUDED.turn_count, " +
        "last_consolidated_turn = EXCLUDED.last_consolidated_turn, " +
        "updated_at = NOW()",
      [
        profile.user_id,
        profile.summary,
        JSON.stringify(profile.preferences),
        profile.ongoing_projects,
        profile.turn_count,
        profile.last_consolidated_turn,
      ],
    );
  }

  /** Delete the profile for `user_id`. Does nothing for an unknown id. */
  async delete(user_id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("DELETE FROM " + this.table + " WHERE user_id = $1", [user_id]);
  }

  /** Close the connection pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Create the table once per store. A failed bootstrap is forgotten so
   * the next call tries again once Postgres is reachable.
   */
  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.bootstrap().catch((err: unknown) => {
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS " + this.table + " (" +
          "user_id TEXT PRIMARY KEY, " +
          "summary TEXT NOT NULL DEFAULT '', " +
          "preferences JSONB NOT NULL DEFAULT '{}', " +
          "ongoing_projects TEXT[] NOT NULL DEFAULT '{}', " +
          "turn_count INTEGER NOT NULL DEFAULT 0, " +
          "last_consolidated_turn INTEGER NOT NULL DEFAULT 0, " +
          "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
          ")",
      );
    } catch (err) {
      if (!isCreateRace(err)) throw err;
    }
  }
}

function isCreateRace(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    CREATE_RACE_CODES.has(String(err.code))
  );
}
