import pg from "pg";
import { randomUUID } from "node:crypto";
import type { Session, SessionStore, ChatMessage } from "@tuttiai/types";

const { Pool } = pg;

export class PostgresSessionStore implements SessionStore {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
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
        console.error(
          `[tutti] Failed to persist session ${session.id} to Postgres: ${err instanceof Error ? err.message : err}`,
        );
      });

    return session;
  }

  get(_id: string): Session | undefined {
    // The synchronous interface returns from an in-memory cache.
    // For Postgres, use getAsync() instead for reliable reads.
    // This returns undefined — the runtime creates a new session on miss.
    return undefined;
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

    const row = result.rows[0];
    return {
      id: row.id,
      agent_name: row.agent_name,
      messages: row.messages as ChatMessage[],
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  update(id: string, messages: ChatMessage[]): void {
    // Fire-and-forget UPDATE
    this.pool
      .query(
        `UPDATE tutti_sessions
         SET messages = $1, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(messages), id],
      )
      .catch((err) => {
        console.error(
          `[tutti] Failed to update session ${id} in Postgres: ${err instanceof Error ? err.message : err}`,
        );
      });
  }

  /** Close the connection pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
