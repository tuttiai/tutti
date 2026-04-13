import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagConfig } from "../types.js";

const parameters = z.object({
  source_id: z
    .string()
    .describe("Identifier of the source document to remove"),
});

/**
 * Build the `delete_source` tool.
 *
 * Stub — the body is intentionally not implemented.
 */
export function createDeleteSourceTool(
  _config: RagConfig,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "delete_source",
    description:
      "Remove a source document and all of its chunks from the knowledge base",
    parameters,
    execute: async (_input) => {
      return {
        content: "delete_source is not implemented yet",
        is_error: true,
      };
    },
  };
}
