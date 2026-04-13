/**
 * BM25 keyword index — a thin wrapper around `wink-bm25-text-search` that
 * handles dynamic updates.
 *
 * The underlying library requires a single `consolidate()` step and then
 * refuses further `addDoc` calls. To support "index and then keep ingesting",
 * we shadow the document set in a `Map` and rebuild the BM25 engine
 * lazily on the next search after any write.
 */

// --- Type shims (wink-* packages ship no TypeScript definitions) --------

interface WinkBm25Engine {
  defineConfig(cfg: { fldWeights: Record<string, number> }): void;
  definePrepTasks(tasks: Array<(input: unknown) => unknown>): void;
  addDoc(doc: Record<string, string>, id: string): void;
  consolidate(): void;
  search(text: string, limit?: number): Array<[string, number]>;
}

type StringTask = (input: string) => string;
type TokenizerTask = (input: string) => string[];
type TokensTask = (input: string[]) => string[];

interface WinkNlpUtils {
  string: {
    lowerCase: StringTask;
    tokenize0: TokenizerTask;
  };
  tokens: {
    stem: TokensTask;
    removeWords: TokensTask;
  };
}

// ------------------------------------------------------------------------

import { createRequire } from "node:module";
const requireLocal = createRequire(import.meta.url);

const bm25Factory = requireLocal("wink-bm25-text-search") as () => WinkBm25Engine;
const nlp = requireLocal("wink-nlp-utils") as WinkNlpUtils;

export interface KeywordDoc {
  chunk_id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface KeywordHit {
  chunk_id: string;
  score: number;
}

function buildEngine(): WinkBm25Engine {
  const engine = bm25Factory();
  engine.defineConfig({ fldWeights: { body: 1 } });
  engine.definePrepTasks([
    // tasks chain: each one receives the previous result.
    nlp.string.lowerCase as (x: unknown) => unknown,
    nlp.string.tokenize0 as (x: unknown) => unknown,
    nlp.tokens.removeWords as (x: unknown) => unknown,
    nlp.tokens.stem as (x: unknown) => unknown,
  ]);
  return engine;
}

/**
 * In-memory BM25 index. Call {@link add} to ingest chunks; {@link search}
 * lazily rebuilds the underlying engine before querying.
 */
export class KeywordIndex {
  private readonly docs = new Map<string, KeywordDoc>();
  private engine: WinkBm25Engine | undefined;
  private dirty = true;

  /** Total indexed chunks. Handy for tests and observability. */
  get size(): number {
    return this.docs.size;
  }

  /** Insert-or-replace. Marks the engine dirty for the next search. */
  add(docs: KeywordDoc[]): void {
    for (const d of docs) this.docs.set(d.chunk_id, d);
    this.dirty = true;
  }

  /**
   * Run BM25 over the indexed corpus and return up to `limit` hits.
   *
   * When `filter` is set, we over-fetch (4x limit) and post-filter by
   * metadata equality, then slice. For a purely in-memory index the
   * overhead is negligible.
   */
  search(
    query: string,
    limit: number,
    filter?: Record<string, string>,
  ): KeywordHit[] {
    if (this.docs.size === 0 || limit <= 0) return [];
    // wink-bm25 refuses to consolidate fewer than 3 docs. Gracefully return
    // an empty hit list — BM25 signal on 1-2 docs is noise anyway.
    if (this.docs.size < 3) return [];
    if (this.dirty || !this.engine) this.rebuild();

    const fetchLimit = filter ? Math.max(limit * 4, 10) : limit;
    const raw = this.engine!.search(query, fetchLimit);

    const filtered: KeywordHit[] = [];
    for (const [id, score] of raw) {
      if (filter) {
        const meta = this.docs.get(id)?.metadata ?? {};
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (meta[k] !== v) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }
      filtered.push({ chunk_id: id, score });
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  private rebuild(): void {
    // Fresh engine — wink-bm25's `reset()` drops config, so building from
    // scratch is simpler than trying to un-consolidate.
    const engine = buildEngine();
    for (const doc of this.docs.values()) {
      engine.addDoc({ body: doc.text }, doc.chunk_id);
    }
    engine.consolidate();
    this.engine = engine;
    this.dirty = false;
  }
}
