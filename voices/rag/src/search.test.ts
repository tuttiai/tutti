import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "./embeddings/types.js";
import { SearchEngine, type LlmFn } from "./search.js";
import { MemoryVectorStore } from "./stores/memory.js";
import type { EmbeddedChunk, VectorStore } from "./stores/types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Mock embedding provider that hashes each input into a deterministic 3D
 * vector. Strings that start with the same token map to similar vectors so
 * we can reason about cosine similarity in assertions.
 */
function createMockEmbeddings(
  mapping: Record<string, number[]> = {},
): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  const provider: EmbeddingProvider & { calls: string[] } = {
    name: "mock",
    dimensions: 3,
    calls,
    embed(texts: string[]): Promise<number[][]> {
      calls.push(...texts);
      return Promise.resolve(
        texts.map((t) => {
          const fixed = mapping[t];
          if (fixed) return normalise(fixed);
          // Default: hash each char to deterministic but diffuse coordinates.
          let a = 0,
            b = 0,
            c = 0;
          for (const ch of t) {
            const code = ch.charCodeAt(0);
            a += Math.sin(code);
            b += Math.cos(code);
            c += Math.sin(code * 2);
          }
          return normalise([a, b, c]);
        }),
      );
    },
  };
  return provider;
}

function normalise(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function makeChunk(
  chunk_id: string,
  source_id: string,
  text: string,
  vector: number[],
  metadata?: Record<string, unknown>,
): EmbeddedChunk {
  return {
    chunk_id,
    source_id,
    chunk_index: 0,
    text,
    vector: normalise(vector),
    ...(metadata ? { metadata } : {}),
  };
}

/** Recording VectorStore stub that returns canned rankings. */
function createRecordingStore(
  results: Record<string, { chunk_id: string; score: number; content: string }[]>,
): VectorStore & { searchCalls: { vector: number[]; topK: number }[] } {
  const searchCalls: { vector: number[]; topK: number }[] = [];
  const store: VectorStore & {
    searchCalls: { vector: number[]; topK: number }[];
  } = {
    name: "recording",
    searchCalls,
    upsert(): Promise<void> {
      return Promise.resolve();
    },
    search(
      vector,
      topK,
    ): Promise<
      Array<{
        chunk_id: string;
        source_id: string;
        content: string;
        score: number;
      }>
    > {
      searchCalls.push({ vector, topK });
      // Return canned results keyed by the first coord's sign — lets us
      // have distinct vectors trigger distinct canned rankings.
      const key = vector[0] > 0 ? "positive" : "negative";
      const canned = results[key] ?? [];
      return Promise.resolve(
        canned.map((c) => ({
          chunk_id: c.chunk_id,
          source_id: "src",
          content: c.content,
          score: c.score,
        })),
      );
    },
    delete(): Promise<void> {
      return Promise.resolve();
    },
    list(): Promise<[]> {
      return Promise.resolve([]);
    },
  };
  return store;
}

// ===========================================================================
// Semantic-only search
// ===========================================================================

describe("SearchEngine — semantic", () => {
  it("embeds the query and searches the store (no HyDE, no hybrid)", async () => {
    const embeddings = createMockEmbeddings({
      "find widgets": [1, 0, 0],
    });
    const store = new MemoryVectorStore();
    await store.upsert([
      makeChunk("a", "s1", "apples are red fruit", [1, 0, 0]),
      makeChunk("b", "s1", "bananas are yellow", [0, 1, 0]),
    ]);

    const engine = new SearchEngine({ embeddings, store });
    const results = await engine.search("find widgets", { topK: 2 });

    expect(embeddings.calls).toEqual(["find widgets"]);
    expect(results).toHaveLength(2);
    expect(results[0].chunk_id).toBe("a"); // aligned with query vector
  });

  it("returns [] when topK is zero or negative", async () => {
    const embeddings = createMockEmbeddings();
    const store = new MemoryVectorStore();
    const engine = new SearchEngine({ embeddings, store });

    expect(await engine.search("x", { topK: 0 })).toEqual([]);
    expect(await engine.search("x", { topK: -5 })).toEqual([]);
    expect(embeddings.calls).toEqual([]);
  });

  it("passes the metadata filter through to the store", async () => {
    const embeddings = createMockEmbeddings({ q: [1, 0, 0] });
    const store = new MemoryVectorStore();
    await store.upsert([
      makeChunk("a", "s1", "x", [1, 0, 0], { lang: "en" }),
      makeChunk("b", "s2", "y", [1, 0, 0], { lang: "fr" }),
    ]);

    const engine = new SearchEngine({ embeddings, store });
    const results = await engine.search("q", {
      topK: 10,
      filter: { lang: "fr" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].chunk_id).toBe("b");
  });
});

// ===========================================================================
// HyDE
// ===========================================================================

describe("SearchEngine — HyDE", () => {
  it("calls the LLM and embeds the hypothetical answer instead of the query", async () => {
    const embeddings = createMockEmbeddings();
    const store = createRecordingStore({
      positive: [{ chunk_id: "A", score: 0.9, content: "apples" }],
    });
    const llm = vi.fn<LlmFn>(() =>
      Promise.resolve("The hypothetical answer paragraph."),
    );

    const engine = new SearchEngine({ embeddings, store, llm });
    await engine.search("what are apples?", { topK: 1, hyde: true });

    expect(llm).toHaveBeenCalledOnce();
    const [prompt] = llm.mock.calls[0];
    expect(prompt).toContain("what are apples?");
    // Provider got the hypothetical answer, NOT the raw query.
    expect(embeddings.calls).toEqual(["The hypothetical answer paragraph."]);
  });

  it("falls back to the raw query when the LLM returns an empty string", async () => {
    const embeddings = createMockEmbeddings();
    const store = createRecordingStore({});
    const llm: LlmFn = () => Promise.resolve("   ");

    const engine = new SearchEngine({ embeddings, store, llm });
    await engine.search("raw query", { topK: 1, hyde: true });

    expect(embeddings.calls).toEqual(["raw query"]);
  });

  it("uses config.hyde by default and options.hyde overrides it", async () => {
    const embeddings = createMockEmbeddings();
    const store = createRecordingStore({});
    const llm = vi.fn<LlmFn>(() => Promise.resolve("hyde answer"));

    const engineConfigOn = new SearchEngine({
      embeddings,
      store,
      llm,
      config: { hyde: true },
    });
    await engineConfigOn.search("q1", { topK: 1 });
    expect(llm).toHaveBeenCalledTimes(1);

    // Option false overrides config true.
    await engineConfigOn.search("q2", { topK: 1, hyde: false });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(embeddings.calls).toContain("q2");
  });

  it("throws when HyDE is enabled but no LLM was provided", async () => {
    const embeddings = createMockEmbeddings();
    const store = new MemoryVectorStore();
    const engine = new SearchEngine({ embeddings, store });

    await expect(
      engine.search("q", { topK: 1, hyde: true }),
    ).rejects.toThrow(/HyDE is enabled but no `llm`/);
  });

  it("uses a custom hyde_prompt when provided", async () => {
    const embeddings = createMockEmbeddings();
    const store = createRecordingStore({});
    const llm = vi.fn<LlmFn>(() => Promise.resolve("answer"));
    const hyde_prompt = (q: string): string => "CUSTOM: " + q;

    const engine = new SearchEngine({
      embeddings,
      store,
      llm,
      config: { hyde: true, hyde_prompt },
    });
    await engine.search("test", { topK: 1 });

    expect(llm).toHaveBeenCalledWith("CUSTOM: test");
  });
});

// ===========================================================================
// Hybrid (BM25 + RRF)
// ===========================================================================

describe("SearchEngine — hybrid", () => {
  it("merges semantic and keyword rankings via RRF", async () => {
    // Semantic says: a > b > c   (vector[0] is positive → "positive" bucket)
    // Keyword says: based on BM25 over the actual chunk text
    const embeddings = createMockEmbeddings({ "apple query": [1, 0, 0] });
    const store = createRecordingStore({
      positive: [
        { chunk_id: "a", score: 0.9, content: "apples are red" },
        { chunk_id: "b", score: 0.8, content: "bananas are yellow" },
        { chunk_id: "c", score: 0.7, content: "cherries are red" },
      ],
    });

    const engine = new SearchEngine({ embeddings, store });
    // BM25 needs ≥3 docs. Index what lives in the "store".
    engine.index([
      makeChunk("a", "s", "apples are red fruit delicious apple", [1, 0, 0]),
      makeChunk("b", "s", "bananas are yellow fruit", [0, 1, 0]),
      makeChunk("c", "s", "cherries are also red fruit", [0, 0, 1]),
    ]);

    const results = await engine.search("apple query", {
      topK: 3,
      hybrid: true,
    });

    expect(results).toHaveLength(3);
    // 'a' should win — top semantic AND top BM25 for "apple".
    expect(results[0].chunk_id).toBe("a");
    // Content was preserved from the semantic hit.
    expect(results[0].content).toBe("apples are red");
  });

  it("de-duplicates chunk IDs that appear in both lists", async () => {
    const embeddings = createMockEmbeddings({ shared: [1, 0, 0] });
    const store = createRecordingStore({
      positive: [
        { chunk_id: "x", score: 0.9, content: "content X" },
        { chunk_id: "y", score: 0.8, content: "content Y" },
        { chunk_id: "z", score: 0.7, content: "content Z" },
      ],
    });
    const engine = new SearchEngine({ embeddings, store });
    engine.index([
      makeChunk("x", "s", "shared shared token vocabulary", [1, 0, 0]),
      makeChunk("y", "s", "distinct content words", [0, 1, 0]),
      makeChunk("z", "s", "another distinct document", [0, 0, 1]),
    ]);

    const results = await engine.search("shared", {
      topK: 10,
      hybrid: true,
    });
    const ids = results.map((r) => r.chunk_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("uses config.rrf_k when merging", async () => {
    const embeddings = createMockEmbeddings({ q: [1, 0, 0] });
    const store = createRecordingStore({
      positive: [
        { chunk_id: "a", score: 0.9, content: "apple" },
        { chunk_id: "b", score: 0.8, content: "banana" },
        { chunk_id: "c", score: 0.7, content: "cherry" },
      ],
    });

    const engine = new SearchEngine({
      embeddings,
      store,
      config: { rrf_k: 1 },
    });
    engine.index([
      makeChunk("a", "s", "apple words", [1, 0, 0]),
      makeChunk("b", "s", "banana words", [0, 1, 0]),
      makeChunk("c", "s", "cherry words", [0, 0, 1]),
    ]);
    const results = await engine.search("q", { topK: 3, hybrid: true });
    expect(results).toHaveLength(3);
    // With k=1, RRF reciprocals are (0.5, 0.333, 0.25) for ranks 1..3;
    // the top semantic result 'a' should stay on top.
    expect(results[0].chunk_id).toBe("a");
  });

  it("honours the filter across both branches", async () => {
    const embeddings = createMockEmbeddings({ q: [1, 0, 0] });
    const store = new MemoryVectorStore();
    await store.upsert([
      makeChunk("en1", "s-en", "english apples red delicious", [1, 0, 0], {
        lang: "en",
      }),
      makeChunk("en2", "s-en", "english bananas yellow good", [0.9, 0.1, 0], {
        lang: "en",
      }),
      makeChunk("fr1", "s-fr", "french pommes rouges apples", [0.95, 0.05, 0], {
        lang: "fr",
      }),
    ]);

    const engine = new SearchEngine({ embeddings, store });
    engine.index([
      makeChunk("en1", "s-en", "english apples red delicious", [1, 0, 0], {
        lang: "en",
      }),
      makeChunk("en2", "s-en", "english bananas yellow good", [0.9, 0.1, 0], {
        lang: "en",
      }),
      makeChunk("fr1", "s-fr", "french pommes rouges apples", [0.95, 0.05, 0], {
        lang: "fr",
      }),
    ]);

    const results = await engine.search("apples", {
      topK: 10,
      hybrid: true,
      filter: { lang: "fr" },
    });
    const ids = results.map((r) => r.chunk_id);
    expect(ids).not.toContain("en1");
    expect(ids).not.toContain("en2");
  });
});

// ===========================================================================
// index() lifecycle
// ===========================================================================

describe("SearchEngine.index", () => {
  it("lets repeated upserts replace existing chunks", async () => {
    const embeddings = createMockEmbeddings({ q: [1, 0, 0] });
    const store = createRecordingStore({
      positive: [
        { chunk_id: "a", score: 0.9, content: "a" },
        { chunk_id: "b", score: 0.8, content: "b" },
        { chunk_id: "c", score: 0.7, content: "c" },
      ],
    });
    const engine = new SearchEngine({ embeddings, store });

    engine.index([
      makeChunk("a", "s", "apple fruit red", [1, 0, 0]),
      makeChunk("b", "s", "banana fruit yellow", [0, 1, 0]),
      makeChunk("c", "s", "cherry fruit small red", [0, 0, 1]),
    ]);
    // Replace 'a' with text that no longer mentions "apple".
    engine.index([makeChunk("a", "s", "tomato vegetable", [1, 0, 0])]);

    const results = await engine.search("apple", { topK: 3, hybrid: true });
    // After replacement, 'a' should not be the top keyword hit.
    // (Semantic can still return it; RRF should not let it dominate.)
    const topIds = results.slice(0, 1).map((r) => r.chunk_id);
    expect(topIds[0]).not.toBe("a");
  });
});
