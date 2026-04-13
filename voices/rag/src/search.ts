import type { EmbeddingProvider } from "./embeddings/types.js";
import { KeywordIndex } from "./keyword-index.js";
import type { EmbeddedChunk, VectorStore } from "./stores/types.js";
import type { SearchResult } from "./types.js";

/** LLM call signature used for HyDE — provider-agnostic by design. */
export type LlmFn = (prompt: string) => Promise<string>;

/** Per-call overrides for a single `search(...)` invocation. */
export interface SearchOptions {
  /** Number of results to return. */
  topK: number;
  /** Enable BM25 + vector fusion via Reciprocal Rank Fusion. */
  hybrid?: boolean;
  /** Override {@link SearchEngineConfig.hyde} for this call. */
  hyde?: boolean;
  /** AND-equality metadata filter. */
  filter?: Record<string, string>;
}

/** Search engine configuration — defaults that apply to every call. */
export interface SearchEngineConfig {
  /** Turn HyDE on by default. Each call can still override via {@link SearchOptions.hyde}. */
  hyde?: boolean;
  /** RRF smoothing constant `k`. Default 60 (canonical). */
  rrf_k?: number;
  /**
   * Build the prompt sent to the LLM when HyDE is enabled. Defaults to a
   * short "write a focused answer paragraph" instruction.
   */
  hyde_prompt?: (query: string) => string;
}

/** Dependencies injected at construction time. */
export interface SearchEngineDeps {
  embeddings: EmbeddingProvider;
  store: VectorStore;
  /** Required only when HyDE is enabled. */
  llm?: LlmFn;
  config?: SearchEngineConfig;
}

const DEFAULT_RRF_K = 60;

/** Default HyDE prompt. Short and directive — no preamble. */
function defaultHydePrompt(query: string): string {
  return (
    "Write a concise, factual paragraph that directly answers the " +
    "following question. Do not add preamble or caveats; write as if " +
    "this paragraph were the answer itself.\n\nQuestion: " +
    query
  );
}

/**
 * Full retrieval pipeline: semantic search, optional HyDE query rewriting,
 * optional BM25 keyword search, and Reciprocal Rank Fusion when both are
 * enabled. All modes apply the same metadata filter.
 *
 * The engine is intentionally provider-agnostic: the LLM call is passed as
 * a dependency, so it can be backed by any Tutti `LLMProvider`, a test
 * double, or a user-supplied function.
 */
export class SearchEngine {
  private readonly embeddings: EmbeddingProvider;
  private readonly store: VectorStore;
  private readonly llm: LlmFn | undefined;
  private readonly config: SearchEngineConfig;
  private readonly keyword = new KeywordIndex();

  constructor(deps: SearchEngineDeps) {
    this.embeddings = deps.embeddings;
    this.store = deps.store;
    this.llm = deps.llm;
    this.config = deps.config ?? {};
  }

  /**
   * Register chunks with the BM25 index. Callers should invoke this for
   * every chunk they upsert to the vector store so keyword search stays in
   * sync. Idempotent per `chunk_id`.
   */
  index(chunks: EmbeddedChunk[]): void {
    this.keyword.add(
      chunks.map((c) => {
        const doc: { chunk_id: string; text: string; metadata?: Record<string, unknown> } = {
          chunk_id: c.chunk_id,
          text: c.text,
        };
        if (c.metadata !== undefined) doc.metadata = c.metadata;
        return doc;
      }),
    );
  }

  /**
   * Drop every BM25 entry whose `metadata.source_id` equals `source_id`.
   * Called by `delete_source` to keep keyword search in sync with the
   * vector store.
   */
  removeSource(source_id: string): number {
    return this.keyword.removeBySource(source_id);
  }

  /**
   * Retrieve chunks ranked by relevance to `query`.
   *
   * @throws When `options.hyde` (or `config.hyde`) is true but no `llm`
   *         dependency was provided.
   */
  async search(
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    if (options.topK <= 0) return [];
    const useHyde = options.hyde ?? this.config.hyde ?? false;
    const useHybrid = options.hybrid ?? false;

    const semantic = await this.semanticSearch(
      query,
      options.topK,
      options.filter,
      useHyde,
    );

    if (!useHybrid) return semantic;

    const keyword = this.keywordSearch(query, options.topK, options.filter);
    return this.merge(semantic, keyword, options.topK);
  }

  // ---------------------------------------------------------------------
  // Semantic (vector) branch
  // ---------------------------------------------------------------------

  private async semanticSearch(
    query: string,
    topK: number,
    filter: Record<string, string> | undefined,
    useHyde: boolean,
  ): Promise<SearchResult[]> {
    const queryText = useHyde ? await this.runHyde(query) : query;
    const [vector] = await this.embeddings.embed([queryText]);
    if (!vector) return [];
    return this.store.search(vector, topK, filter);
  }

  private async runHyde(query: string): Promise<string> {
    if (!this.llm) {
      throw new Error(
        "SearchEngine: HyDE is enabled but no `llm` dependency was provided",
      );
    }
    const prompt = (this.config.hyde_prompt ?? defaultHydePrompt)(query);
    const answer = await this.llm(prompt);
    // Fall back to the original query if the LLM returns nothing useful —
    // an embed call on "" is wasteful and unhelpful.
    return answer.trim().length > 0 ? answer : query;
  }

  // ---------------------------------------------------------------------
  // Keyword (BM25) branch
  // ---------------------------------------------------------------------

  private keywordSearch(
    query: string,
    topK: number,
    filter: Record<string, string> | undefined,
  ): SearchResult[] {
    const hits = this.keyword.search(query, topK, filter);
    // Note: BM25 scores are unbounded. We keep them here for RRF ranking,
    // then drop them in the merge step where normalised semantic scores win.
    return hits.map((h) => ({
      chunk_id: h.chunk_id,
      source_id: "", // unknown until merged with the semantic hit
      content: "", // populated during merge from the semantic result
      score: h.score,
    }));
  }

  // ---------------------------------------------------------------------
  // Hybrid merge via Reciprocal Rank Fusion
  // ---------------------------------------------------------------------

  private merge(
    semantic: SearchResult[],
    keyword: SearchResult[],
    topK: number,
  ): SearchResult[] {
    const k = this.config.rrf_k ?? DEFAULT_RRF_K;

    // Canonical source of truth for each chunk's content/metadata is the
    // semantic hit (it has the full record). Keyword hits are identified
    // by chunk_id only.
    const byId = new Map<string, SearchResult>();
    const rrfScore = new Map<string, number>();

    for (let i = 0; i < semantic.length; i++) {
      const hit = semantic[i]!;
      byId.set(hit.chunk_id, hit);
      rrfScore.set(hit.chunk_id, (rrfScore.get(hit.chunk_id) ?? 0) + 1 / (k + (i + 1)));
    }
    for (let i = 0; i < keyword.length; i++) {
      const hit = keyword[i]!;
      rrfScore.set(hit.chunk_id, (rrfScore.get(hit.chunk_id) ?? 0) + 1 / (k + (i + 1)));
    }

    // De-dup: every chunk_id gets a single entry with the accumulated
    // RRF score as its ranking signal.
    const merged = Array.from(rrfScore.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([chunk_id, score]) => {
        const canonical = byId.get(chunk_id);
        if (canonical) return { ...canonical, score };
        // Keyword-only hit — we don't have the full chunk record locally.
        // Surface what we know; callers can hydrate via the store if needed.
        return {
          chunk_id,
          source_id: "",
          content: "",
          score,
        };
      });

    return merged;
  }
}
