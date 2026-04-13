import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagContext } from "../tool-context.js";

const parameters = z.object({
  query: z.string().min(1).describe("Natural-language search query"),
  top_k: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return (default 5)"),
  hybrid: z
    .boolean()
    .optional()
    .describe("Fuse BM25 + semantic ranking via RRF"),
  filter: z
    .record(z.string())
    .optional()
    .describe("Metadata equality filter (AND-combined)"),
});

type SearchKnowledgeInput = z.infer<typeof parameters>;

interface FormattedHit {
  text: string;
  score: number;
  source_url: string;
  chunk_index: number | null;
}

/**
 * Wire the `search_knowledge` tool. Defaults to top-5 semantic search;
 * callers can opt into hybrid (BM25+RRF) by setting `hybrid: true`.
 */
export function createSearchKnowledgeTool(
  ctx: RagContext,
): Tool<SearchKnowledgeInput> {
  const defaultTopK = ctx.config.default_top_k ?? 5;

  return {
    name: "search_knowledge",
    description:
      "Search the knowledge base for chunks relevant to the query",
    parameters,
    execute: async (input): Promise<{ content: string; is_error?: boolean }> => {
      try {
        const topK = input.top_k ?? defaultTopK;
        const results = await ctx.engine.search(input.query, {
          topK,
          ...(input.hybrid !== undefined ? { hybrid: input.hybrid } : {}),
          ...(input.filter !== undefined ? { filter: input.filter } : {}),
        });

        const formatted: FormattedHit[] = results.map((r) => {
          const meta = r.metadata ?? {};
          const sourceUrl =
            typeof meta.source === "string" ? meta.source : r.source_id;
          const chunkIndex =
            typeof meta.chunk_index === "number" ? meta.chunk_index : null;
          return {
            text: r.content,
            score: r.score,
            source_url: sourceUrl,
            chunk_index: chunkIndex,
          };
        });

        return { content: JSON.stringify(formatted) };
      } catch (err) {
        return {
          content:
            "search_knowledge failed: " +
            (err instanceof Error ? err.message : String(err)),
          is_error: true,
        };
      }
    },
  };
}
