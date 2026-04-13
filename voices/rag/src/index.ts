import type { Permission, Tool, Voice } from "@tuttiai/types";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { SearchEngine, type LlmFn } from "./search.js";
import { createVectorStore } from "./stores/index.js";
import { createIngestDocumentTool } from "./tools/ingest-document.js";
import { createSearchKnowledgeTool } from "./tools/search-knowledge.js";
import { createListSourcesTool } from "./tools/list-sources.js";
import { createDeleteSourceTool } from "./tools/delete-source.js";
import type { RagContext } from "./tool-context.js";
import type { RagConfig } from "./types.js";

// --- public re-exports -----------------------------------------------------

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
  createEmbeddingProvider,
  OpenAIEmbeddingProvider,
  AnthropicEmbeddingProvider,
  LocalEmbeddingProvider,
  EmbeddingRequestError,
  type EmbeddingProvider,
  type EmbeddingConfig,
  type OpenAIEmbeddingConfig,
  type AnthropicEmbeddingConfig,
  type LocalEmbeddingConfig,
} from "./embeddings/index.js";
export {
  createVectorStore,
  MemoryVectorStore,
  PgVectorStore,
  type VectorStore,
  type EmbeddedChunk,
  type VectorStoreConfig,
  type MemoryStoreConfig,
  type PgVectorStoreConfig,
} from "./stores/index.js";
export {
  SearchEngine,
  type SearchOptions,
  type SearchEngineConfig,
  type SearchEngineDeps,
  type LlmFn,
} from "./search.js";
export { KeywordIndex } from "./keyword-index.js";

// --- voice factory ---------------------------------------------------------

/**
 * Extra construction options for {@link RagVoice} that don't belong on the
 * serialisable {@link RagConfig}. An `llm` callback is required for HyDE
 * query rewriting; without it, `config.hyde` is ignored.
 */
export interface RagVoiceOptions {
  /**
   * Callback used by the HyDE query-rewriter. Receives a prompt, returns
   * the LLM's response. Callers typically wrap their Tutti LLMProvider here.
   */
  llm?: LlmFn;
}

/**
 * Build the RAG voice. Constructs an {@link EmbeddingProvider}, a
 * {@link VectorStore}, and a {@link SearchEngine} from `config`, wires them
 * into the four tools, and returns the resulting {@link Voice}.
 *
 * `required_permissions` is `["network"]` because every sensible embedding
 * backend performs a network round-trip; local Ollama runs still pass the
 * permission check.
 *
 * @example
 * const voice = RagVoice({
 *   collection: "product-docs",
 *   embeddings: { provider: "openai", api_key: process.env.OPENAI_API_KEY! },
 *   storage: { provider: "memory" },
 * });
 */
export function RagVoice(config: RagConfig, options: RagVoiceOptions = {}): Voice {
  const embeddings = createEmbeddingProvider(config);
  const store = createVectorStore(config);

  const engineDeps: {
    embeddings: typeof embeddings;
    store: typeof store;
    llm?: LlmFn;
    config?: { hyde?: boolean };
  } = { embeddings, store };
  if (options.llm !== undefined) engineDeps.llm = options.llm;
  if (config.hyde !== undefined) engineDeps.config = { hyde: config.hyde };
  const engine = new SearchEngine(engineDeps);

  const ctx: RagContext = { config, embeddings, store, engine };

  const tools: Tool[] = [
    createIngestDocumentTool(ctx),
    createSearchKnowledgeTool(ctx),
    createListSourcesTool(ctx),
    createDeleteSourceTool(ctx),
  ];

  return {
    name: "rag",
    description:
      "Retrieval-augmented generation: ingest documents and search a knowledge base",
    required_permissions: ["network"] satisfies Permission[],
    tools,
  };
}
