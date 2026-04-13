import { SecretsManager } from "@tuttiai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgVectorStore } from "./pgvector.js";
import type { EmbeddedChunk } from "./types.js";

/**
 * Integration tests — require a reachable Postgres with the `vector`
 * extension available. Enabled by setting RAG_PG_URL, e.g.:
 *
 *   RAG_PG_URL=postgres://postgres:postgres@localhost:5432/rag_test npm test
 *
 * Uses a per-run table name so parallel runs don't clobber each other.
 */

const CONNECTION_STRING = SecretsManager.optional("RAG_PG_URL");
const suite = CONNECTION_STRING ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "rag_chunks_test_" + suffix;

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

suite("PgVectorStore (integration)", () => {
  let store: PgVectorStore;

  beforeAll(() => {
    store = new PgVectorStore({
      provider: "pgvector",
      connection_string: CONNECTION_STRING,
      table: TABLE,
    });
  });

  afterAll(async () => {
    // Clean up the per-run table. Go through the pool directly so teardown
    // still succeeds even if an earlier test left the schema half-built.
    const admin = new PgVectorStore({
      provider: "pgvector",
      connection_string: CONNECTION_STRING,
      table: TABLE,
    });
    try {
      // Access the private pool via a type assertion — tests-only.
      const pooled = admin as unknown as {
        pool: { query: (text: string) => Promise<unknown> };
      };
      await pooled.pool.query("DROP TABLE IF EXISTS " + TABLE);
    } finally {
      await admin.close();
      await store.close();
    }
  });

  it("auto-creates the extension and table on first use", async () => {
    await store.upsert([makeChunk("a", "s1", unit(0))]);
    const results = await store.search(unit(0), 1);
    expect(results).toHaveLength(1);
    expect(results[0].chunk_id).toBe("a");
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("ranks results by cosine similarity", async () => {
    await store.upsert([
      makeChunk("near", "s1", unit(0.1)),
      makeChunk("mid", "s1", unit(Math.PI / 4)),
      makeChunk("far", "s1", unit(Math.PI - 0.1)),
    ]);
    const results = await store.search(unit(0), 3);
    const ids = results.map((r) => r.chunk_id);
    expect(ids[0]).toBe("near");
    expect(ids).toContain("mid");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("applies JSONB containment filters", async () => {
    await store.upsert([
      makeChunk("en1", "s-en", unit(0), { lang: "en" }),
      makeChunk("fr1", "s-fr", unit(0), { lang: "fr" }),
    ]);
    const results = await store.search(unit(0), 10, { lang: "en" });
    const ids = results.map((r) => r.chunk_id);
    expect(ids).toContain("en1");
    expect(ids).not.toContain("fr1");
  });

  it("upsert replaces rows with the same chunk_id", async () => {
    await store.upsert([
      makeChunk("dup", "s1", unit(0), { version: "v1" }),
    ]);
    await store.upsert([
      makeChunk("dup", "s1", unit(Math.PI / 2), { version: "v2" }),
    ]);

    const results = await store.search(unit(Math.PI / 2), 1);
    expect(results[0].chunk_id).toBe("dup");
    expect(results[0].metadata).toMatchObject({ version: "v2" });
  });

  it("delete removes every chunk for the source", async () => {
    await store.upsert([
      makeChunk("x1", "s-del", unit(0)),
      makeChunk("x2", "s-del", unit(0.1)),
    ]);
    await store.delete("s-del");
    const results = await store.search(unit(0), 100, {});
    expect(results.map((r) => r.chunk_id)).not.toContain("x1");
    expect(results.map((r) => r.chunk_id)).not.toContain("x2");
  });

  it("list groups by source with chunk counts", async () => {
    await store.upsert([
      makeChunk("l1", "listed-src", unit(0), { title: "Listed" }),
      makeChunk("l2", "listed-src", unit(0.1)),
    ]);
    const sources = await store.list();
    const match = sources.find((s) => s.source_id === "listed-src");
    if (!match) throw new Error("listed-src missing from list()");
    expect(match.chunk_count).toBeGreaterThanOrEqual(2);
    expect(match.title).toBe("Listed");
  });
});

describe("PgVectorStore constructor", () => {
  it("throws when no connection string is available", () => {
    // Accessing process.env here is allowed because this block is the
    // test's inverse of SecretsManager — we need to transiently unset the
    // variable so the constructor genuinely finds nothing.
     
    const env = process.env as Record<string, string | undefined>;
    const saved = env.RAG_PG_URL;
    delete env.RAG_PG_URL;
    try {
      expect(
        () => new PgVectorStore({ provider: "pgvector" }),
      ).toThrow(/connection_string/);
    } finally {
      if (saved !== undefined) env.RAG_PG_URL = saved;
    }
  });

  it("rejects invalid table identifiers", () => {
    expect(
      () =>
        new PgVectorStore({
          provider: "pgvector",
          connection_string: "postgres://x",
          table: "drop; --",
        }),
    ).toThrow(/identifier/);
  });
});
