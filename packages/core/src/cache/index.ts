/**
 * Tool result caching primitives. See {@link ToolCache} for the interface
 * and {@link InMemoryToolCache} for the default bounded LRU implementation.
 */

export type { ToolCache } from "./tool-cache.js";
export {
  InMemoryToolCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
} from "./in-memory-cache.js";
export type { InMemoryToolCacheOptions } from "./in-memory-cache.js";

/**
 * Tool names that always bypass the cache regardless of configuration.
 * These are known side-effect / write tools from the built-in voices:
 * caching their responses would stale-serve mutations.
 *
 * Users can extend this list per-agent via
 * `AgentConfig.cache.excluded_tools`.
 */
export const DEFAULT_WRITE_TOOLS: readonly string[] = [
  "write_file",
  "delete_file",
  "move_file",
  "create_issue",
  "comment_on_issue",
];
