import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@tuttiai/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkStrategy, RagVoice } from "./index.js";

// ---------------------------------------------------------------------------
// End-to-end happy path: ingest → search through the Voice's Tool surface.
//
// Uses mocked OpenAI embeddings so the test is deterministic and offline.
// The mock returns orthogonal unit vectors keyed by topic keywords, so
// cosine similarity picks out the chunk that shares topic with the query.
// ---------------------------------------------------------------------------

const TOPICS = {
  apple: [1, 0, 0, 0] as const,
  widget: [0, 1, 0, 0] as const,
  ocean: [0, 0, 1, 0] as const,
  neutral: [0, 0, 0, 1] as const,
} satisfies Record<string, readonly number[]>;

function embedFor(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("widget")) return [...TOPICS.widget];
  if (lower.includes("apple")) return [...TOPICS.apple];
  if (lower.includes("ocean")) return [...TOPICS.ocean];
  return [...TOPICS.neutral];
}

interface OpenAIEmbeddingsRequestBody {
  input: string[];
  model: string;
}

interface JsonResponseShape {
  data: { index: number; embedding: number[] }[];
  model: string;
}

function findTool<T = unknown>(tools: Tool[], name: string): Tool<T> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error("tool " + name + " not found");
  return t as Tool<T>;
}

describe("RagVoice end-to-end", () => {
  let workDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "rag-e2e-"));

    fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as OpenAIEmbeddingsRequestBody;
      const data = body.input.map((text, index) => ({
        index,
        embedding: embedFor(text),
      }));
      const payload: JsonResponseShape = {
        data,
        model: "text-embedding-3-small",
      };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(workDir, { recursive: true, force: true });
  });

  it("ingests three paragraphs and surfaces the right one on search", async () => {
    // Three orthogonal paragraphs — each keyword steers the mock embedder
    // toward a different axis so we can verify the ranker picks the
    // semantically-relevant chunk.
    const paragraphs = [
      "The first paragraph talks about apples and the pie they make when baked.",
      "The second paragraph discusses widgets and the machinery used in factories.",
      "The third paragraph is about oceans and how coastal weather forms.",
    ];
    const filePath = join(workDir, "doc.txt");
    await writeFile(filePath, paragraphs.join("\n\n"));

    const voice = RagVoice({
      collection: "e2e",
      embeddings: { provider: "openai", api_key: "sk-test" },
      storage: { provider: "memory" },
    });

    // --- ingest_document --------------------------------------------------
    const ingest = findTool<Record<string, unknown>>(voice.tools, "ingest_document");
    const ingestResult = await ingest.execute(
      {
        source: filePath,
        source_id: "doc-1",
        strategy: ChunkStrategy.Paragraph,
      },
      { session_id: "s", agent_name: "a" },
    );
    expect(ingestResult.is_error).toBeFalsy();
    const ingestPayload = JSON.parse(ingestResult.content) as {
      source_id: string;
      chunks_created: number;
      source: string;
    };
    expect(ingestPayload.source_id).toBe("doc-1");
    expect(ingestPayload.chunks_created).toBe(3);
    expect(ingestPayload.source).toBe(filePath);

    // --- search_knowledge -------------------------------------------------
    const search = findTool<Record<string, unknown>>(voice.tools, "search_knowledge");
    const searchResult = await search.execute(
      { query: "tell me about widgets in factories", top_k: 3 },
      { session_id: "s", agent_name: "a" },
    );
    expect(searchResult.is_error).toBeFalsy();
    const hits = JSON.parse(searchResult.content) as Array<{
      text: string;
      score: number;
      source_url: string;
      chunk_index: number | null;
    }>;
    expect(hits).toHaveLength(3);

    // The second paragraph must win — only it shares the "widget" vector
    // with the query.
    expect(hits[0].text).toBe(paragraphs[1]);
    expect(hits[0].source_url).toBe(filePath);
    expect(hits[0].chunk_index).toBe(1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    // --- list_sources -----------------------------------------------------
    const list = findTool(voice.tools, "list_sources");
    const listResult = await list.execute(
      {},
      { session_id: "s", agent_name: "a" },
    );
    const sources = JSON.parse(listResult.content) as Array<{
      source_id: string;
      filename: string;
      chunks: number;
      ingested_at: string;
    }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].source_id).toBe("doc-1");
    expect(sources[0].filename).toBe("doc.txt");
    expect(sources[0].chunks).toBe(3);

    // --- delete_source ----------------------------------------------------
    const del = findTool<{ source_id: string }>(voice.tools, "delete_source");
    const delResult = await del.execute(
      { source_id: "doc-1" },
      { session_id: "s", agent_name: "a" },
    );
    const delPayload = JSON.parse(delResult.content) as {
      source_id: string;
      deleted: boolean;
      removed_from_keyword: number;
    };
    expect(delPayload).toMatchObject({ source_id: "doc-1", deleted: true });
    expect(delPayload.removed_from_keyword).toBe(3);

    // After delete, search should return nothing.
    const postDeleteResult = await search.execute(
      { query: "widgets" },
      { session_id: "s", agent_name: "a" },
    );
    const postDeleteHits = JSON.parse(postDeleteResult.content) as unknown[];
    expect(postDeleteHits).toEqual([]);
  });
});
