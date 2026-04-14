import { SecretsManager, createLogger } from "@tuttiai/core";
import type { Permission, Tool, ToolContext, ToolResult, Voice } from "@tuttiai/types";
import { resolveProvider } from "./providers/index.js";
import { BraveProvider } from "./providers/brave.js";
import { SerperProvider } from "./providers/serper.js";
import { DuckDuckGoProvider } from "./providers/duckduckgo.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createFetchSitemapTool } from "./tools/fetch-sitemap.js";
import type { SearchProvider, ProviderOptions } from "./types.js";
import { DEFAULT_TIMEOUT_MS } from "./types.js";
import { ToolRateLimiter, RateLimitError } from "./rate-limiter.js";

export type { SearchResult, SearchProvider, ProviderOptions } from "./types.js";
export { DEFAULT_TIMEOUT_MS } from "./types.js";
export { resolveProvider, BraveProvider, SerperProvider, DuckDuckGoProvider } from "./providers/index.js";
export { createWebSearchTool } from "./tools/web-search.js";
export { createFetchUrlTool } from "./tools/fetch-url.js";
export { createFetchSitemapTool } from "./tools/fetch-sitemap.js";
export { cacheKey, getCached, setCached, clearCache, SEARCH_TTL_MS, FETCH_TTL_MS } from "./cache.js";
export { ToolRateLimiter, RateLimitError } from "./rate-limiter.js";

const logger = createLogger("tutti-web");

/**
 * Configuration for {@link WebVoice}.
 */
export interface WebVoiceConfig {
  /**
   * Search provider to use. When omitted the voice auto-selects based
   * on available API keys (Brave > Serper > DuckDuckGo).
   */
  provider?: "brave" | "serper" | "duckduckgo" | SearchProvider;
  /**
   * Enable or disable the LRU result cache. Default: `true`.
   * Disabling is useful in tests or when freshness matters more than
   * latency.
   */
  cache?: boolean;
  /**
   * Default number of results returned by `web_search` (1–20).
   * The agent can still override per-call via the `limit` parameter.
   * Default: `5`.
   */
  max_results?: number;
  /**
   * Per-tool rate limit (calls per minute). When set, every tool in
   * the voice is gated by a shared sliding-window counter. Exceeding
   * the budget returns `{ content, is_error: true }` with the
   * remaining wait time.
   */
  rate_limit?: { per_minute: number };
  /** HTTP request timeout in milliseconds. Default: 5000. */
  timeout_ms?: number;
}

/**
 * Resolve a `WebVoiceConfig.provider` value to a {@link SearchProvider}.
 */
function buildProvider(
  cfg: WebVoiceConfig["provider"],
  timeout_ms: number,
): SearchProvider {
  if (typeof cfg === "object" && cfg !== null && "search" in cfg) {
    return cfg;
  }

  const opts: ProviderOptions = { timeout_ms };

  switch (cfg) {
    case "brave": {
      const key = SecretsManager.require("BRAVE_SEARCH_API_KEY");
      return new BraveProvider(key, opts);
    }
    case "serper": {
      const key = SecretsManager.require("SERPER_API_KEY");
      return new SerperProvider(key, opts);
    }
    case "duckduckgo":
      return new DuckDuckGoProvider(opts);
    default:
      return resolveProvider(timeout_ms);
  }
}

/**
 * Wrap every tool so that each `execute` call passes through the rate
 * limiter first. Returns `{ content, is_error: true }` when the limit
 * is exceeded instead of throwing, matching the Tutti tool contract.
 */
function withRateLimit(tools: Tool[], limiter: ToolRateLimiter): Tool[] {
  return tools.map((t) => ({
    ...t,
    execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      try {
        limiter.check(t.name);
      } catch (err) {
        if (err instanceof RateLimitError) {
          return { content: err.message, is_error: true };
        }
        throw err;
      }
      return t.execute(input, ctx);
    },
  }));
}

/**
 * Web voice — gives agents web search, URL fetching, and sitemap
 * crawling.
 *
 * @example
 * ```ts
 * import { WebVoice } from "@tuttiai/web";
 *
 * const score = defineScore({
 *   agents: {
 *     researcher: {
 *       voices: [new WebVoice({ provider: "brave", max_results: 10 })],
 *       permissions: ["network"],
 *     },
 *   },
 * });
 * ```
 */
export class WebVoice implements Voice {
  readonly name = "web";
  readonly description = "Search the web, fetch pages, and read sitemaps";
  readonly required_permissions: Permission[] = ["network"];
  readonly tools: Tool[];

  constructor(config: WebVoiceConfig = {}) {
    const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const provider = buildProvider(config.provider, timeout);
    const maxResults = config.max_results ?? 5;

    if (config.provider !== undefined) {
      logger.info({ provider: provider.name }, "Web voice provider");
    }

    let tools: Tool[] = [
      createWebSearchTool(provider, maxResults),
      createFetchUrlTool(),
      createFetchSitemapTool(),
    ];

    if (config.rate_limit) {
      const limiter = new ToolRateLimiter(config.rate_limit.per_minute);
      tools = withRateLimit(tools, limiter);
    }

    this.tools = tools;
  }
}
