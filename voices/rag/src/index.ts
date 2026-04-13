import type { Permission, Tool, Voice } from "@tuttiai/types";
import { createIngestDocumentTool } from "./tools/ingest-document.js";
import { createSearchKnowledgeTool } from "./tools/search-knowledge.js";
import { createListSourcesTool } from "./tools/list-sources.js";
import { createDeleteSourceTool } from "./tools/delete-source.js";
import type { RagConfig } from "./types.js";

export type {
  RagConfig,
  IngestOptions,
  SearchResult,
  SourceRecord,
  Chunk,
  ChunkOptions,
  IngestSourceInput,
} from "./types.js";
export { ChunkStrategy } from "./types.js";
export { ingestDocument, loadSource } from "./ingest.js";

export {
  createIngestDocumentTool,
  createSearchKnowledgeTool,
  createListSourcesTool,
  createDeleteSourceTool,
};

/**
 * Build a RAG voice for the given configuration.
 *
 * The returned {@link Voice} can be passed to an `AgentConfig`'s `voices`
 * array. Tools are stubs — wire up an embedder and vector store backend
 * before relying on them at runtime.
 *
 * @example
 * const voice = RagVoice({ collection: "product-docs" });
 * const agent = { name: "support", voices: [voice], ... };
 */
export function RagVoice(config: RagConfig): Voice {
  const tools: Tool[] = [
    createIngestDocumentTool(config),
    createSearchKnowledgeTool(config),
    createListSourcesTool(config),
    createDeleteSourceTool(config),
  ];

  return {
    name: "rag",
    description:
      "Retrieval-augmented generation: ingest documents and search a knowledge base",
    required_permissions: ["network"] satisfies Permission[],
    tools,
  };
}
