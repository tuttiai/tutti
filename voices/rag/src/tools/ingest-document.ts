import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { RagConfig } from "../types.js";

const parameters = z.object({
  source_id: z.string().describe("Stable identifier for the source document"),
  content: z.string().describe("Raw text content to ingest"),
  title: z.string().optional().describe("Human-readable title"),
  mime_type: z.string().optional().describe("MIME type (e.g. text/markdown)"),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe("Free-form metadata stored with the source"),
});

/**
 * Build the `ingest_document` tool.
 *
 * Stub — the body is intentionally not implemented. Wire up a chunker,
 * embedder, and vector store before using.
 */
export function createIngestDocumentTool(
  _config: RagConfig,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "ingest_document",
    description:
      "Ingest a document into the knowledge base, chunking and embedding it for later retrieval",
    parameters,
    execute: async (_input) => {
      return {
        content: "ingest_document is not implemented yet",
        is_error: true,
      };
    },
  };
}
