/**
 * Semantic memory entry / store re-exports.
 *
 * The canonical type definitions live in `@tuttiai/types` so
 * `AgentConfig.memory.semantic.store` can reference them without
 * crossing the types <- core dependency direction. This module exists
 * so existing core consumers (and downstream packages that imported
 * from here in v0.21) keep compiling unchanged.
 */

export type {
  MemoryEntry,
  SemanticSearchOptions,
  SemanticMemoryStore,
} from "@tuttiai/types";
