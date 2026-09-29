import type { Permission, Tool, Voice } from "@tuttiai/types";

import { createKnowledgeClient, type KnowledgeFetch } from "./client.js";
import { KnowledgeVoiceConfigSchema, type KnowledgeVoiceConfig } from "./config-schema.js";
import { createListKnowledgeBasesTool } from "./tools/list-knowledge-bases.js";
import { createSearchKnowledgeBasesTool } from "./tools/search-knowledge-bases.js";

const DEFAULT_TOP_K = 5;

/** What {@link KnowledgeVoice} takes besides its configuration. */
export interface KnowledgeVoiceDependencies {
  /** The `fetch` to call. Defaults to the global one; tests pass a fake. */
  readonly fetch?: KnowledgeFetch;
}

/**
 * Gives an agent read-only search over knowledge bases a knowledge service holds for it.
 *
 * Unlike `@tuttiai/rag`, which ingests and stores inside the agent's own process, this voice
 * holds nothing: the service ingests, stores and decides which bases the agent may read, and
 * the agent can only list and search them. Nothing it does changes a base, so no tool is
 * destructive.
 */
export class KnowledgeVoice implements Voice {
  name = "knowledge";
  description = "Search the knowledge bases shared with this agent";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  /**
   * @param config - The service address and this agent's token. Validated here too, so a
   * caller that skipped the schema still cannot build a voice without them.
   * @param dependencies - The `fetch` to call.
   */
  constructor(config: KnowledgeVoiceConfig, dependencies: KnowledgeVoiceDependencies = {}) {
    const parsed = KnowledgeVoiceConfigSchema.parse(config);
    const client = createKnowledgeClient(parsed, dependencies.fetch);
    this.tools = [
      createListKnowledgeBasesTool(client),
      createSearchKnowledgeBasesTool(client, parsed.default_top_k ?? DEFAULT_TOP_K),
    ];
  }
}

export { createKnowledgeClient } from "./client.js";
export type { KnowledgeClient, KnowledgeFetch, KnowledgeResult } from "./client.js";
export { KnowledgeVoiceConfigSchema, type KnowledgeVoiceConfig } from "./config-schema.js";
export {
  KnowledgeBaseSummarySchema,
  ListBasesResponseSchema,
  SearchHitSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  type KnowledgeBaseSummary,
  type ListBasesResponse,
  type SearchHit,
  type SearchRequest,
  type SearchResponse,
} from "./protocol.js";
