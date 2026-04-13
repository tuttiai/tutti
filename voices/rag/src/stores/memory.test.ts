import { describe, expect, it } from "vitest";

import { MemoryVectorStore } from "./memory.js";
import { createVectorStore } from "./index.js";
import type { EmbeddedChunk } from "./types.js";

/** Build a unit-normalised 2D vector at angle `theta` (radians). */
function unit(theta: number): number[] {
  return [Math.cos(theta), Math.sin(theta)];
}

function makeChunk(
  chunk_id: string,
  source_id: string,
  vector: number[],
  metadata?: Record<string, unknown>,
): EmbeddedChunk {
  return {
    chunk_id,
    source_id,
    chunk_index: 0,
    text: "text-" + chunk_id,
    vector,
    ...(metadata ? { metadata } : {}),
  };
}

describe("MemoryVectorStore", () => {
  describe("upsert", () => {
    it("stores new chunks and replaces by chunk_id", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([makeChunk("a", "s1", unit(0))]);
      await store.upsert([makeChunk("a", "s1", unit(Math.PI / 2))]);

      // Query along the y-axis — should get a near-perfect match with the
      // replacement vector, not the original.
      const hits = await store.search(unit(Math.PI / 2), 1);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.chunk_id).toBe("a");
      expect(hits[0]!.score).toBeCloseTo(1, 10);
    });

    it("rejects dimension mismatches after the first insert", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([makeChunk("a", "s1", [1, 0, 0])]);
      await expect(
        store.upsert([makeChunk("b", "s1", [1, 0])]),
      ).rejects.toThrow(/dimension/);
    });
  });

  describe("search", () => {
    it("returns top_k by descending cosine similarity", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([
        makeChunk("near", "s1", unit(0.1)), // very close to query
        makeChunk("mid", "s1", unit(Math.PI / 4)),
        makeChunk("far", "s1", unit(Math.PI - 0.1)), // nearly opposite
      ]);

      const results = await store.search(unit(0), 2);
      expect(results).toHaveLength(2);
      expect(results[0]!.chunk_id).toBe("near");
      expect(results[1]!.chunk_id).toBe("mid");
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    });

    it("clamps negative cosines to 0", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([makeChunk("opp", "s1", unit(Math.PI))]);

      const [hit] = await store.search(unit(0), 1);
      expect(hit!.score).toBe(0);
    });

    it("applies AND-equality metadata filters", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([
        makeChunk("a", "s1", unit(0), { lang: "en", tier: "public" }),
        makeChunk("b", "s2", unit(0), { lang: "fr", tier: "public" }),
        makeChunk("c", "s3", unit(0), { lang: "en", tier: "private" }),
      ]);

      const results = await store.search(unit(0), 10, {
        lang: "en",
        tier: "public",
      });
      expect(results.map((r) => r.chunk_id)).toEqual(["a"]);
    });

    it("returns [] for empty store or non-positive top_k", async () => {
      const store = new MemoryVectorStore();
      expect(await store.search(unit(0), 5)).toEqual([]);

      await store.upsert([makeChunk("a", "s1", unit(0))]);
      expect(await store.search(unit(0), 0)).toEqual([]);
      expect(await store.search(unit(0), -1)).toEqual([]);
    });

    it("rejects query-dimension mismatches", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([makeChunk("a", "s1", [1, 0, 0])]);
      await expect(store.search([1, 0], 1)).rejects.toThrow(/dimension/);
    });

    it("yields to the event loop across batches", async () => {
      // Seed with > 1000 vectors to force a second batch; measure that an
      // independently-queued setImmediate interleaves with the scan.
      const store = new MemoryVectorStore();
      const chunks: EmbeddedChunk[] = [];
      for (let i = 0; i < 1500; i++) {
        chunks.push(makeChunk("c" + i, "s1", unit(i * 0.001)));
      }
      await store.upsert(chunks);

      let tickRan = false;
      setImmediate(() => {
        tickRan = true;
      });
      const results = await store.search(unit(0), 5);
      expect(results).toHaveLength(5);
      expect(tickRan).toBe(true);
    });
  });

  describe("delete", () => {
    it("removes every chunk for the given source_id", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([
        makeChunk("a", "s1", unit(0)),
        makeChunk("b", "s1", unit(0.1)),
        makeChunk("c", "s2", unit(0.2)),
      ]);
      await store.delete("s1");

      const results = await store.search(unit(0), 10);
      expect(results.map((r) => r.chunk_id)).toEqual(["c"]);
    });

    it("is a no-op for unknown source_ids", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([makeChunk("a", "s1", unit(0))]);
      await store.delete("does-not-exist");
      expect(await store.search(unit(0), 10)).toHaveLength(1);
    });
  });

  describe("list", () => {
    it("groups by source_id with chunk counts and metadata", async () => {
      const store = new MemoryVectorStore();
      await store.upsert([
        makeChunk("a", "s1", unit(0), { title: "Doc 1" }),
        makeChunk("b", "s1", unit(0.1)),
        makeChunk("c", "s2", unit(0.2), { title: "Doc 2", mime_type: "text/markdown" }),
      ]);

      const sources = await store.list();
      const byId = Object.fromEntries(sources.map((s) => [s.source_id, s]));

      expect(byId.s1!.chunk_count).toBe(2);
      expect(byId.s1!.title).toBe("Doc 1");
      expect(byId.s2!.chunk_count).toBe(1);
      expect(byId.s2!.mime_type).toBe("text/markdown");
    });

    it("returns an empty list when nothing has been ingested", async () => {
      const store = new MemoryVectorStore();
      expect(await store.list()).toEqual([]);
    });
  });

  describe("createVectorStore factory", () => {
    it("defaults to memory when storage is unset", () => {
      const store = createVectorStore({ collection: "c" });
      expect(store).toBeInstanceOf(MemoryVectorStore);
    });

    it("dispatches memory explicitly", () => {
      const store = createVectorStore({
        collection: "c",
        storage: { provider: "memory" },
      });
      expect(store).toBeInstanceOf(MemoryVectorStore);
    });

    it("rejects unknown provider discriminators", () => {
      const bad = {
        provider: "faiss",
      } as unknown as { provider: "memory" };
      expect(() =>
        createVectorStore({ collection: "c", storage: bad }),
      ).toThrow(/unknown provider/);
    });
  });
});
