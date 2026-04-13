/**
 * Tool result cache — stores deterministic tool outputs so repeated calls
 * within a session (or across sessions) can short-circuit expensive work
 * like HTTP requests or file reads.
 *
 * ⚠ Write / side-effect tools are NEVER cached. The {@link AgentRunner}
 * applies a built-in exclusion list covering write_file, delete_file,
 * move_file, create_issue, comment_on_issue (extendable via
 * `AgentConfig.cache.excluded_tools`). Errored results (`is_error: true`)
 * are likewise never cached so transient failures don't get locked in.
 */

import type { ToolResult } from "@tuttiai/types";

export interface ToolCache {
  /**
   * Look up a cached result.
   *
   * @param tool - Tool name (e.g. `"read_file"`).
   * @param input - The tool input; serialized to form part of the cache key.
   * @returns The cached {@link ToolResult} or `null` if absent / expired.
   */
  get(tool: string, input: unknown): Promise<ToolResult | null>;

  /**
   * Store a result under `(tool, input)`.
   *
   * @param ttl_ms - Per-entry TTL override. Falls back to the cache's default.
   */
  set(
    tool: string,
    input: unknown,
    result: ToolResult,
    ttl_ms?: number,
  ): Promise<void>;

  /**
   * Invalidate either a single `(tool, input)` entry (when `input` is given)
   * or every entry for `tool` (when `input` is omitted).
   */
  invalidate(tool: string, input?: unknown): Promise<void>;

  /** Drop every entry in the cache. */
  clear(): Promise<void>;
}
