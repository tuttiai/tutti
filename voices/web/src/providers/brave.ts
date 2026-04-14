import { createLogger } from "@tuttiai/core";
import type { SearchResult, SearchProvider, ProviderOptions } from "../types.js";

const logger = createLogger("tutti-web-brave");

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

/**
 * Brave Search API response shapes — only the fields we use.
 *
 * @see https://api.search.brave.com/app/documentation/web-search
 */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

interface BraveApiResponse {
  web?: { results?: BraveWebResult[] };
}

/**
 * Search provider backed by the Brave Search API.
 *
 * Requires `BRAVE_SEARCH_API_KEY` environment variable.
 */
export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, options: ProviderOptions) {
    this.apiKey = apiKey;
    this.timeoutMs = options.timeout_ms;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = new URL(BRAVE_API_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 20)));

    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, query },
          "Brave Search API error",
        );
        return [];
      }

      const data = (await response.json()) as BraveApiResponse;
      const results = data.web?.results ?? [];

      return results
        .filter((r): r is BraveWebResult & { title: string; url: string } =>
          typeof r.title === "string" && typeof r.url === "string",
        )
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
          published_date: r.page_age,
        }));
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), query },
        "Brave Search request failed",
      );
      return [];
    }
  }
}
