/** Public types for the RAG voice. */

import type { EmbeddingConfig } from "./embeddings/types.js";

/**
 * Chunking strategies supported by the ingestion pipeline.
 *
 * - `fixed` — split by approximate token count with overlap between windows.
 * - `sentence` — split on sentence boundaries (`.`, `!`, `?`).
 * - `paragraph` — split on blank lines (double newlines).
 */
export enum ChunkStrategy {
  Fixed = "fixed",
  Sentence = "sentence",
  Paragraph = "paragraph",
}

/**
 * A single chunk of text produced by the ingestion pipeline, ready to be
 * embedded and stored in a vector index.
 */
export interface Chunk {
  /** The chunk's text content. */
  text: string;
  /** Identifier of the source document this chunk belongs to. */
  source_id: string;
  /** Zero-based position of this chunk within its source. */
  chunk_index: number;
  /** Copy of source metadata merged with chunk-level fields (e.g. strategy). */
  metadata?: Record<string, unknown>;
}

/**
 * One input document to feed into the ingestion pipeline. Exactly one of
 * `path` or `url` must be set.
 */
export interface IngestSourceInput {
  /** Stable identifier for this source. Used as `Chunk.source_id`. */
  source_id: string;
  /** Local filesystem path. Mutually exclusive with `url`. */
  path?: string;
  /** Remote URL (http(s) or GitHub). Mutually exclusive with `path`. */
  url?: string;
  /** Human-readable title. */
  title?: string;
  /** MIME type override. When unset the pipeline infers from extension/headers. */
  mime_type?: string;
  /** Free-form metadata propagated to every resulting chunk. */
  metadata?: Record<string, unknown>;
}

/**
 * Options controlling how a document is chunked.
 */
export interface ChunkOptions {
  /** Chunking strategy. Defaults to {@link ChunkStrategy.Fixed}. */
  strategy?: ChunkStrategy;
  /**
   * For `fixed`: target number of whitespace-separated tokens per chunk.
   * Ignored by other strategies. Defaults to 512.
   */
  chunk_size?: number;
  /**
   * For `fixed`: fraction of `chunk_size` to overlap between consecutive
   * windows. Clamped to [0, 0.9]. Defaults to 0.2 (20%).
   */
  overlap_ratio?: number;
}

/**
 * Configuration accepted by the {@link RagVoice} factory.
 *
 * Concrete implementations of the embedding store, vector index, and
 * embedding model are intentionally not pinned here — the voice is meant to
 * be backend-agnostic.
 */
export interface RagConfig {
  /** Identifier for the knowledge collection this voice operates on. */
  collection: string;
  /** Embedding provider configuration. Consumed by `createEmbeddingProvider`. */
  embeddings?: EmbeddingConfig;
  /** Default top-K returned by `search_knowledge` if not specified per call. */
  default_top_k?: number;
  /** Maximum number of characters per chunk during ingestion. */
  chunk_size?: number;
  /** Number of overlapping characters between adjacent chunks. */
  chunk_overlap?: number;
}

/**
 * Options controlling how a single document is ingested into the knowledge
 * base.
 */
export interface IngestOptions {
  /** Stable identifier for the source. Re-ingesting with the same id replaces it. */
  source_id: string;
  /** Optional human-readable title of the document. */
  title?: string;
  /** Optional MIME type — used to select a parser/chunker. */
  mime_type?: string;
  /** Free-form metadata stored alongside the source record. */
  metadata?: Record<string, unknown>;
}

/**
 * A single retrieval result returned by `search_knowledge`.
 */
export interface SearchResult {
  /** Identifier of the chunk within the knowledge base. */
  chunk_id: string;
  /** Identifier of the source document this chunk belongs to. */
  source_id: string;
  /** The chunk's text content. */
  content: string;
  /** Similarity score in the range [0, 1]; higher is more relevant. */
  score: number;
  /** Optional metadata copied from the source record. */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata describing one ingested source document.
 */
export interface SourceRecord {
  source_id: string;
  title?: string;
  mime_type?: string;
  /** Number of chunks the source was split into. */
  chunk_count: number;
  /** ISO-8601 timestamp of the most recent ingestion. */
  ingested_at: string;
  metadata?: Record<string, unknown>;
}
