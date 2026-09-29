import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { KnowledgeClient } from "../client.js";

const parameters = z
  .object({
    query: z.string().min(1).max(2_000).describe("What to look for, in plain words. Exact terms and names are matched too."),
    top_k: z.number().int().min(1).max(20).optional().describe("How many passages to return."),
    bases: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe("Handles from list_knowledge_bases to search. Omit to search every base you may read."),
  })
  .strict();

/**
 * `search_knowledge_bases`: the passages most relevant to a query, from the bases this agent may
 * read. Each result names its base and source, so an answer can cite where it came from.
 *
 * @param client - The agent's knowledge client.
 * @param defaultTopK - How many passages to return when the model does not say.
 * @returns The tool.
 */
export function createSearchKnowledgeBasesTool(client: KnowledgeClient, defaultTopK: number): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_knowledge_bases",
    description:
      "Search the knowledge bases you may read for passages relevant to a query. Cite the source of anything you use.",
    parameters,
    execute: async (input) => {
      const answer = await client.search({
        query: input.query,
        top_k: input.top_k ?? defaultTopK,
        ...(input.bases === undefined ? {} : { bases: input.bases }),
      });
      if (!answer.ok) return { content: answer.message, is_error: true };
      if (answer.data.results.length === 0) {
        return { content: `Nothing in ${answer.data.searched.join(", ") || "your knowledge bases"} matched "${input.query}". Try other words.` };
      }
      return { content: JSON.stringify(answer.data) };
    },
  };
}
