import type { Chunk, SearchResult, SourceRecord } from "../types.js";

/** A {@link Chunk} paired with its embedding vector, ready to be persisted. */
export interface EmbeddedChunk extends Chunk {
  /** Unit-normalised embedding vector for {@link Chunk.text}. */
  vector: number[];
  /** Unique identifier. Assigned by the caller (e.g. `${source_id}:${chunk_index}`). */
  chunk_id: string;
}

/**
 * Persistence contract for embedded chunks. Implementations MUST:
 *
 * - treat `upsert` as "insert-or-replace by `chunk_id`"
 * - return cosine-similarity scores in `[0, 1]` from `search`
 *   (higher = more relevant), already sorted descending
 * - apply `filter` as AND-equality against chunk metadata
 * - remove every chunk that belongs to `source_id` in `delete`
 * - enumerate unique sources (not chunks) in `list`
 */
export interface VectorStore {
  readonly name: string;
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  search(
    vector: number[],
    top_k: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]>;
  delete(source_id: string): Promise<void>;
  list(): Promise<SourceRecord[]>;
}

/** Configuration for the in-memory vector store. */
export interface MemoryStoreConfig {
  provider: "memory";
}

/** Configuration for the pgvector-backed vector store. */
export interface PgVectorStoreConfig {
  provider: "pgvector";
  /**
   * Postgres connection string. Falls back to the `RAG_PG_URL` env var.
   * At least one must be set.
   */
  connection_string?: string;
  /** Table name. Default: `rag_chunks`. */
  table?: string;
}

/** Discriminated union of every supported vector store configuration. */
export type VectorStoreConfig = MemoryStoreConfig | PgVectorStoreConfig;
