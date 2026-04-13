import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagContext } from "../tool-context.js";

const parameters = z.object({
  source_id: z
    .string()
    .min(1)
    .describe("Identifier of the source document to remove"),
});

type DeleteSourceInput = z.infer<typeof parameters>;

/**
 * Wire the `delete_source` tool: drop every chunk whose `source_id`
 * matches, across both the vector store and the BM25 keyword index.
 */
export function createDeleteSourceTool(
  ctx: RagContext,
): Tool<DeleteSourceInput> {
  return {
    name: "delete_source",
    description:
      "Remove every chunk for the given source document from the knowledge base",
    parameters,
    execute: async (input): Promise<{ content: string; is_error?: boolean }> => {
      try {
        await ctx.store.delete(input.source_id);
        const removed_from_keyword = ctx.engine.removeSource(input.source_id);
        return {
          content: JSON.stringify({
            source_id: input.source_id,
            deleted: true,
            removed_from_keyword,
          }),
        };
      } catch (err) {
        return {
          content:
            "delete_source failed: " +
            (err instanceof Error ? err.message : String(err)),
          is_error: true,
        };
      }
    },
  };
}
