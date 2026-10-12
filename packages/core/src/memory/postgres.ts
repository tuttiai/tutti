import pg from "pg";
import { randomUUID } from "node:crypto";
import type { Session, SessionStore, ChatMessage } from "@tuttiai/types";
import { logger } from "../logger.js";
import { SessionLru, type SessionStoreBounds } from "../session-lru.js";

const { Pool } = pg;

/**
 * Keeps sessions in a `tutti_sessions` table. Writes are fire-and-forget,
 * because the {@link SessionStore} interface is synchronous; every session
 * this store creates, updates or loads is also held in a bounded in-memory
 * cache, so `get` answers for those, and `load` reads any other from the
 * database.
 */
export class PostgresSessionStore implements SessionStore {
  private pool: InstanceType<typeof Pool>;
  private readonly cache = new Map<string, Session>();
  private readonly lru: SessionLru;

  /**
   * @param connectionString - The Postgres connection URL.
   * @param cache - Bounds for the in-memory cache. Evicting from it never touches the table.
   */
  constructor(connectionString: string, cache: SessionStoreBounds = {}) {
    this.pool = new Pool({ connectionString });
    this.lru = new SessionLru(cache, (id) => this.cache.delete(id));
  }

  /**
   * Create the tutti_sessions table if it doesn't exist.
   * Call this once before using the store.
   */
  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tutti_sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        messages JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  create(agent_name: string): Session {
    const session: Session = {
      id: randomUUID(),
      agent_name,
      messages: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.remember(session);

    // Fire-and-forget INSERT — the session object is returned synchronously
    // to satisfy the SessionStore interface
    this.pool
      .query(
        `INSERT INTO tutti_sessions (id, agent_name, messages, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          session.id,
          session.agent_name,
          JSON.stringify(session.messages),
          session.created_at,
          session.updated_at,
        ],
      )
      .catch((err) => {
        logger.error(
          { error: err instanceof Error ? err.message : String(err), session: session.id },
          "Failed to persist session to Postgres",
        );
      });

    return session;
  }

  /**
   * A session this store created, updated or loaded, from its cache. Use
   * {@link load} for one only the database holds.
   */
  get(id: string): Session | undefined {
    if (!this.lru.isLive(id)) return undefined;
    const session = this.cache.get(id);
    if (session) this.lru.touch(id);
    return session;
  }

  /**
   * Read a session from the cache, or else from the database, caching it so
   * `get` and `update` see it afterwards.
   *
   * @param id - The session id.
   * @returns The session, or `undefined` when the table holds none by that id.
   */
  async load(id: string): Promise<Session | undefined> {
    const cached = this.get(id);
    if (cached) return cached;
    const session = await this.getAsync(id);
    if (session) this.remember(session);
    return session;
  }

  /**
   * Async version of get() that queries Postgres directly.
   * Use this when you need to load a session from the database.
   */
  async getAsync(id: string): Promise<Session | undefined> {
    const result = await this.pool.query(
      `SELECT id, agent_name, messages, created_at, updated_at
       FROM tutti_sessions WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return undefined;

    const row = result.rows[0] as {
      id: string;
      agent_name: string;
      messages: ChatMessage[];
      created_at: string;
      updated_at: string;
    };
    return {
      id: row.id,
      agent_name: row.agent_name,
      messages: row.messages,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  update(id: string, messages: ChatMessage[]): void {
    const cached = this.get(id);
    if (cached) {
      cached.messages = messages;
      cached.updated_at = new Date();
    }
    // Fire-and-forget UPDATE
    this.pool
      .query(
        `UPDATE tutti_sessions
         SET messages = $1, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(messages), id],
      )
      .catch((err) => {
        logger.error(
          { error: err instanceof Error ? err.message : String(err), session: id },
          "Failed to update session in Postgres",
        );
      });
  }

  private remember(session: Session): void {
    this.cache.set(session.id, session);
    this.lru.touch(session.id);
  }

  /** Close the connection pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
