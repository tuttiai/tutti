import { SecretsManager, createLogger } from "@tuttiai/core";
import type { SearchProvider, ProviderOptions } from "../types.js";
import { DEFAULT_TIMEOUT_MS } from "../types.js";
import { BraveProvider } from "./brave.js";
import { SerperProvider } from "./serper.js";
import { DuckDuckGoProvider } from "./duckduckgo.js";

const logger = createLogger("tutti-web");

/**
 * Auto-select a search provider based on which API key is available.
 *
 * Priority: Brave (best result quality) → Serper → DuckDuckGo (free,
 * limited results).
 *
 * @param timeout_ms - HTTP request timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}.
 * @returns The highest-priority provider whose key is configured.
 */
export function resolveProvider(timeout_ms: number = DEFAULT_TIMEOUT_MS): SearchProvider {
  const opts: ProviderOptions = { timeout_ms };

  const braveKey = SecretsManager.optional("BRAVE_SEARCH_API_KEY");
  if (braveKey) {
    logger.info("Using Brave Search provider");
    return new BraveProvider(braveKey, opts);
  }

  const serperKey = SecretsManager.optional("SERPER_API_KEY");
  if (serperKey) {
    logger.info("Using Serper provider");
    return new SerperProvider(serperKey, opts);
  }

  logger.info("No search API key found — falling back to DuckDuckGo (free tier, limited results)");
  return new DuckDuckGoProvider(opts);
}

export { BraveProvider } from "./brave.js";
export { SerperProvider } from "./serper.js";
export { DuckDuckGoProvider } from "./duckduckgo.js";
