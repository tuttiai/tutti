import { SecretsManager } from "@tuttiai/core";
import { Pool, type PoolClient } from "pg";
import { toSql } from "pgvector";
import type { SearchResult, SourceRecord } from "../types.js";
import type {
  EmbeddedChunk,
  PgVectorStoreConfig,
  VectorStore,
} from "./types.js";

const DEFAULT_TABLE = "rag_chunks";

// Identifier allow-list — we can't use parameters for table names, so the
// config value must match this pattern before being interpolated.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

interface ChunkRow {
  chunk_id: string;
  source_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: string; // pg returns numeric as string
}

interface SourceRow {
  source_id: string;
  chunk_count: string;
  ingested_at: Date;
  metadata: Record<string, unknown> | null;
}

/**
 * pgvector-backed {@link VectorStore}. On first use, ensures the `vector`
 * extension is installed and creates the chunk table + source index if
 * missing (idempotent). Cosine distance (`<=>`) drives search.
 */
export class PgVectorStore implements VectorStore {
  public readonly name = "pgvector";

  private readonly pool: Pool;
  private readonly table: string;
  private ready: Promise<void> | undefined;

  constructor(config: PgVectorStoreConfig) {
    const connectionString =
      config.connection_string ?? SecretsManager.optional("RAG_PG_URL");
    if (!connectionString) {
      throw new Error(
        "PgVectorStore: connection_string is required (or set RAG_PG_URL)",
      );
    }

    const table = config.table ?? DEFAULT_TABLE;
    if (!IDENT_RE.test(table)) {
      throw new Error(
        "PgVectorStore: table '" + table + "' is not a valid identifier",
      );
    }

    this.pool = new Pool({ connectionString });
    this.table = table;
  }

  /** Release the underlying pg Pool. Call on shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureSchema();
    const sql =
      "INSERT INTO " +
      this.table +
      " (chunk_id, source_id, content, metadata, vector, updated_at) " +
      "VALUES ($1, $2, $3, $4::jsonb, $5::vector, NOW()) " +
      "ON CONFLICT (chunk_id) DO UPDATE SET " +
      "source_id = EXCLUDED.source_id, " +
      "content = EXCLUDED.content, " +
      "metadata = EXCLUDED.metadata, " +
      "vector = EXCLUDED.vector, " +
      "updated_at = NOW()";

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of chunks) {
        await client.query(sql, [
          c.chunk_id,
          c.source_id,
          c.text,
          JSON.stringify(c.metadata ?? {}),
          toSql(c.vector),
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async search(
    vector: number[],
    top_k: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]> {
    if (top_k <= 0) return [];
    await this.ensureSchema();

    const sql =
      "SELECT chunk_id, source_id, content, metadata, " +
      "(1 - (vector <=> $1::vector)) AS score " +
      "FROM " +
      this.table +
      " WHERE metadata @> $2::jsonb " +
      "ORDER BY vector <=> $1::vector " +
      "LIMIT $3";

    const { rows } = await this.pool.query<ChunkRow>(sql, [
      toSql(vector),
      JSON.stringify(filter ?? {}),
      top_k,
    ]);

    return rows.map((r) => ({
      chunk_id: r.chunk_id,
      source_id: r.source_id,
      content: r.content,
      score: clamp01(Number(r.score)),
      ...(r.metadata !== null ? { metadata: r.metadata } : {}),
    }));
  }

  async delete(source_id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "DELETE FROM " + this.table + " WHERE source_id = $1",
      [source_id],
    );
  }

  async list(): Promise<SourceRecord[]> {
    await this.ensureSchema();

    const sql =
      "SELECT source_id, " +
      "COUNT(*)::bigint AS chunk_count, " +
      "MIN(created_at) AS ingested_at, " +
      "(ARRAY_AGG(metadata ORDER BY chunk_id))[1] AS metadata " +
      "FROM " +
      this.table +
      " GROUP BY source_id " +
      "ORDER BY source_id";

    const { rows } = await this.pool.query<SourceRow>(sql);
    return rows.map((r) => {
      const meta = r.metadata ?? undefined;
      const title =
        meta && typeof meta.title === "string" ? meta.title : undefined;
      const mime =
        meta && typeof meta.mime_type === "string"
          ? meta.mime_type
          : undefined;
      return {
        source_id: r.source_id,
        ...(title !== undefined ? { title } : {}),
        ...(mime !== undefined ? { mime_type: mime } : {}),
        chunk_count: Number(r.chunk_count),
        ingested_at: r.ingested_at.toISOString(),
        ...(meta !== undefined ? { metadata: meta } : {}),
      };
    });
  }

  /** Install the extension and create the chunk table on first use. */
  private ensureSchema(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.runSchema().catch((err: unknown) => {
      // Reset on failure so the next call retries — a transient DB outage
      // shouldn't permanently poison the store.
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async runSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await this.runTableDdl(client);
    } finally {
      client.release();
    }
  }

  private async runTableDdl(client: PoolClient): Promise<void> {
    await client.query(
      "CREATE TABLE IF NOT EXISTS " +
        this.table +
        " (" +
        "chunk_id TEXT PRIMARY KEY, " +
        "source_id TEXT NOT NULL, " +
        "content TEXT NOT NULL, " +
        "metadata JSONB NOT NULL DEFAULT '{}'::jsonb, " +
        "vector vector NOT NULL, " +
        "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
        "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
        ")",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS " +
        this.table +
        "_source_idx ON " +
        this.table +
        " (source_id)",
    );
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}
