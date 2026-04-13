import type { SearchResult, SourceRecord } from "../types.js";
import type { EmbeddedChunk, MemoryStoreConfig, VectorStore } from "./types.js";

/**
 * Number of chunks scanned per synchronous tick during `search`. Kept small
 * enough that a 100k-chunk scan yields to the event loop ~100 times; each
 * batch of 1000 dot products is well under a millisecond on modern hardware.
 */
const SCAN_BATCH_SIZE = 1000;

interface SourceSummary {
  source_id: string;
  title?: string;
  mime_type?: string;
  chunk_count: number;
  last_seen: string;
  metadata?: Record<string, unknown>;
}

/**
 * In-memory brute-force cosine store. Suitable for unit tests, prototyping,
 * and small knowledge bases (≤100k chunks). For anything larger, back the
 * RAG voice with pgvector.
 *
 * Vectors are assumed to be unit-normalised by the embedding provider, so
 * cosine similarity reduces to a dot product — no per-query normalisation.
 */
export class MemoryVectorStore implements VectorStore {
  public readonly name = "memory";

  private readonly chunks = new Map<string, EmbeddedChunk>();
  private expectedDim: number | undefined;

   
  constructor(_config: MemoryStoreConfig = { provider: "memory" }) {
    // Config is reserved for future flags (e.g. max chunks); no-op for now.
  }

  upsert(chunks: EmbeddedChunk[]): Promise<void> {
    for (const c of chunks) {
      if (this.expectedDim === undefined) this.expectedDim = c.vector.length;
      if (c.vector.length !== this.expectedDim) {
        return Promise.reject(
          new Error(
            "MemoryVectorStore: vector dimension mismatch — expected " +
              this.expectedDim +
              ", got " +
              c.vector.length,
          ),
        );
      }
      this.chunks.set(c.chunk_id, c);
    }
    return Promise.resolve();
  }

  async search(
    vector: number[],
    top_k: number,
    filter?: Record<string, string>,
  ): Promise<SearchResult[]> {
    if (top_k <= 0 || this.chunks.size === 0) return [];
    if (this.expectedDim !== undefined && vector.length !== this.expectedDim) {
      throw new Error(
        "MemoryVectorStore: query dimension " +
          vector.length +
          " does not match stored dimension " +
          this.expectedDim,
      );
    }

    const entries = Array.from(this.chunks.values());
    const scored: SearchResult[] = [];

    // Process in SCAN_BATCH_SIZE windows, yielding to the event loop between
    // batches so a 100k-chunk scan can't block incoming HTTP / timer work.
    let scanned = 0;
    for (const chunk of entries) {
      if (!filter || matchesFilter(chunk, filter)) {
        scored.push({
          chunk_id: chunk.chunk_id,
          source_id: chunk.source_id,
          content: chunk.text,
          score: clamp01(cosine(vector, chunk.vector)),
          metadata: chunk.metadata,
        });
      }
      scanned += 1;
      if (scanned % SCAN_BATCH_SIZE === 0 && scanned < entries.length) {
        await yieldToEventLoop();
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, top_k);
  }

  delete(source_id: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.source_id === source_id) this.chunks.delete(id);
    }
    return Promise.resolve();
  }

  list(): Promise<SourceRecord[]> {
    const summaries = new Map<string, SourceSummary>();
    for (const chunk of this.chunks.values()) {
      const existing = summaries.get(chunk.source_id);
      if (existing) {
        existing.chunk_count += 1;
        continue;
      }
      const meta = chunk.metadata ?? {};
      summaries.set(chunk.source_id, {
        source_id: chunk.source_id,
        title: typeof meta.title === "string" ? meta.title : undefined,
        mime_type: typeof meta.mime_type === "string" ? meta.mime_type : undefined,
        chunk_count: 1,
        last_seen: new Date().toISOString(),
        metadata: chunk.metadata,
      });
    }
    return Promise.resolve(
      Array.from(summaries.values()).map((s) => ({
        source_id: s.source_id,
        ...(s.title !== undefined ? { title: s.title } : {}),
        ...(s.mime_type !== undefined ? { mime_type: s.mime_type } : {}),
        chunk_count: s.chunk_count,
        ingested_at: s.last_seen,
        ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
      })),
    );
  }

  /** Test-only: clear all state. Not part of the VectorStore contract. */
  reset(): void {
    this.chunks.clear();
    this.expectedDim = undefined;
  }
}

/** Dot product; correct cosine only when both vectors are unit-normalised. */
function cosine(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // `i` is a bounded counter, not user input; security/detect-object-injection
    // is a false positive over numeric arrays.
    /* eslint-disable security/detect-object-injection */
    const av = a[i];
    const bv = b[i];
    /* eslint-enable security/detect-object-injection */
    if (av !== undefined && bv !== undefined) sum += av * bv;
  }
  return sum;
}

/** Clamp to [0, 1] — embeddings can produce tiny negative cosines we treat as 0. */
function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function matchesFilter(
  chunk: EmbeddedChunk,
  filter: Record<string, string>,
): boolean {
  const meta = chunk.metadata ?? {};
  for (const [key, expected] of Object.entries(filter)) {
    // `key` originates from the trusted filter object; only compared, never assigned.
    const value = Object.prototype.hasOwnProperty.call(meta, key)
      ? Reflect.get(meta, key)
      : undefined;
    if (value !== expected) return false;
  }
  return true;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
