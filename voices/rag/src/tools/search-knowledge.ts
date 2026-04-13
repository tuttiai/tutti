import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagConfig } from "../types.js";

const parameters = z.object({
  query: z.string().describe("Natural-language search query"),
  top_k: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return"),
  filter: z
    .record(z.unknown())
    .optional()
    .describe("Metadata filter applied to candidate sources"),
});

/**
 * Build the `search_knowledge` tool.
 *
 * Stub — the body is intentionally not implemented. Wire up an embedder and
 * vector store before using.
 */
export function createSearchKnowledgeTool(
  _config: RagConfig,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_knowledge",
    description:
      "Search the knowledge base for chunks relevant to the given query",
    parameters,
    execute: async (_input) => {
      return {
        content: "search_knowledge is not implemented yet",
        is_error: true,
      };
    },
  };
}
