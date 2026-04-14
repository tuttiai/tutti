import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import type { SearchProvider, SearchResult } from "../types.js";
import { cacheKey, getCached, setCached, SEARCH_TTL_MS } from "../cache.js";

/**
 * Build the Zod schema for web_search, allowing the voice to set a
 * custom default for `limit` via {@link WebVoiceConfig.max_results}.
 */
function buildParameters(defaultLimit: number): z.ZodObject<{
  query: z.ZodString;
  limit: z.ZodDefault<z.ZodNumber>;
}> {
  return z.object({
    query: z
      .string()
      .min(1)
      .describe("Search query — use natural language or keywords"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(defaultLimit)
      .describe(`Maximum number of results to return (default ${defaultLimit})`),
  });
}

/**
 * Format search results as a readable string for the LLM.
 */
function formatResults(
  results: SearchResult[],
  provider: string,
): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const lines = results.map((r, i) => {
    let entry = `${i + 1}. ${r.title}\n   ${r.url}`;
    if (r.snippet) entry += `\n   ${r.snippet}`;
    if (r.published_date) entry += `\n   Published: ${r.published_date}`;
    return entry;
  });

  return `${results.length} results via ${provider}:\n\n${lines.join("\n\n")}`;
}

/**
 * Create the `web_search` tool backed by the given provider.
 *
 * Results are cached for {@link SEARCH_TTL_MS} (10 min) by default.
 *
 * @param provider - A resolved {@link SearchProvider} instance.
 * @param maxResults - Default result limit exposed to the LLM (1–20, default 5).
 */
export function createWebSearchTool(
  provider: SearchProvider,
  maxResults: number = 5,
): Tool<z.infer<ReturnType<typeof buildParameters>>> {
  const parameters = buildParameters(maxResults);

  return {
    name: "web_search",
    description:
      "Search the web for current information. Returns titles, URLs, and snippets.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      const key = cacheKey(input.query, provider.name);
      const cached = getCached<SearchResult[]>(key);

      if (cached) {
        return { content: formatResults(cached, provider.name + " (cached)") };
      }

      const results = await provider.search(input.query, input.limit);
      if (results.length > 0) {
        setCached(key, results, SEARCH_TTL_MS);
      }
      return { content: formatResults(results, provider.name) };
    },
  };
}
