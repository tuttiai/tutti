import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagConfig } from "../types.js";

const parameters = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of sources to return"),
  cursor: z
    .string()
    .optional()
    .describe("Opaque pagination cursor returned by a previous call"),
});

/**
 * Build the `list_sources` tool.
 *
 * Stub — the body is intentionally not implemented.
 */
export function createListSourcesTool(
  _config: RagConfig,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_sources",
    description: "List ingested source documents in the knowledge base",
    parameters,
    execute: async (_input) => {
      return {
        content: "list_sources is not implemented yet",
        is_error: true,
      };
    },
  };
}
