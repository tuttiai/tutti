/** Public types for the RAG voice. */

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
  /** Embedding model identifier (e.g. "text-embedding-3-small"). */
  embedding_model?: string;
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
