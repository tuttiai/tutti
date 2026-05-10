import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { SecretsManager } from "@tuttiai/core";

/** Narrow shape of a pg PoolClient that our tools touch. */
export interface PostgresClientLike {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  release(): void;
}

/** Narrow shape of a pg Pool — what wrappers and tools see. */
export interface PostgresPoolLike {
  connect(): Promise<PostgresClientLike>;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

/** Async factory used by PostgresClientWrapper; swappable in tests. */
export type PoolFactory = (config: PoolConfig) => PostgresPoolLike;

function defaultFactory(config: PoolConfig): PostgresPoolLike {
  return new Pool(config);
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 5;

/**
 * Singleton wrapper around a pg {@link Pool}. The pool is created
 * lazily on the first tool call; subsequent calls share it. Safe to
 * call {@link getPool} concurrently — concurrent calls await the same
 * in-flight construction promise.
 *
 * `statement_timeout` is configured pool-wide so even direct
 * `pool.query()` calls cannot hang the agent loop indefinitely.
 */
export class PostgresClientWrapper {
  private pool?: PostgresPoolLike;
  private initPromise?: Promise<PostgresPoolLike>;

  constructor(
    private readonly poolConfig: PoolConfig,
    private readonly factory: PoolFactory = defaultFactory,
  ) {}

  async getPool(): Promise<PostgresPoolLike> {
    if (this.pool) return this.pool;
    if (this.initPromise) return this.initPromise;

    // Factory is synchronous, but we cache as a Promise so concurrent
    // callers between the assignment and resolution share the same value.
    this.initPromise = Promise.resolve().then(() => {
      const p = this.factory(this.poolConfig);
      this.pool = p;
      return p;
    });

    try {
      return await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      this.initPromise = undefined;
    }
  }
}

/** Config for creating a PostgresClient. */
export interface PostgresClientOptions {
  /**
   * Postgres connection string (e.g. `postgres://user:pass@host:5432/db`).
   * Defaults to `DATABASE_URL`, then `POSTGRES_URL`.
   */
  connection_string?: string;
  /**
   * Per-statement timeout enforced server-side. Prevents a runaway query
   * from hanging the agent. Defaults to 30 seconds.
   */
  statement_timeout_ms?: number;
  /**
   * Max simultaneous connections in the pool. Defaults to 5 — agents
   * typically run sequential queries, and most managed Postgres
   * deployments cap connections aggressively.
   */
  max_connections?: number;
  /** Custom Pool factory — primarily for tests. */
  poolFactory?: PoolFactory;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing config; they hand the
 * message back as a ToolResult via `guardClient`.
 */
export type PostgresClient =
  | { kind: "ready"; wrapper: PostgresClientWrapper; statement_timeout_ms: number }
  | { kind: "missing"; message: string };

/**
 * Resolve connection details from options then env. Never throws —
 * returns `kind: "missing"` when no connection string is configured so
 * individual tool calls can surface the same helpful message without
 * crashing the voice at construction time.
 */
export function createPostgresClient(
  options: PostgresClientOptions = {},
): PostgresClient {
  const connectionString =
    options.connection_string ??
    SecretsManager.optional("DATABASE_URL") ??
    SecretsManager.optional("POSTGRES_URL");

  if (!connectionString) {
    return {
      kind: "missing",
      message:
        "Postgres voice is not configured. Set DATABASE_URL (or POSTGRES_URL) to a connection string of the form 'postgres://user:pass@host:5432/dbname'. The role only needs the privileges you want the agent to use — for read-only agents, grant SELECT on the schemas you want exposed and nothing else.",
    };
  }

  const statement_timeout_ms =
    options.statement_timeout_ms ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const max = options.max_connections ?? DEFAULT_MAX_CONNECTIONS;

  const config: PoolConfig = {
    connectionString,
    max,
    statement_timeout: statement_timeout_ms,
    // Reject SSL config errors loudly — never silently fall back to plaintext.
    // pg honours `?sslmode=` from the connection string, so we don't override here.
  };

  return {
    kind: "ready",
    wrapper: new PostgresClientWrapper(config, options.poolFactory),
    statement_timeout_ms,
  };
}
