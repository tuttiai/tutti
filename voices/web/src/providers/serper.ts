import { createLogger } from "@tuttiai/core";
import type { SearchResult, SearchProvider, ProviderOptions } from "../types.js";

const logger = createLogger("tutti-web-serper");

const SERPER_API_URL = "https://google.serper.dev/search";

/**
 * Serper.dev API response shapes — only the fields we use.
 *
 * @see https://serper.dev/docs
 */
interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

interface SerperApiResponse {
  organic?: SerperOrganicResult[];
}

/**
 * Search provider backed by the Serper.dev Google Search API.
 *
 * Requires `SERPER_API_KEY` environment variable.
 */
export class SerperProvider implements SearchProvider {
  readonly name = "serper";
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, options: ProviderOptions) {
    this.apiKey = apiKey;
    this.timeoutMs = options.timeout_ms;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const response = await fetch(SERPER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": this.apiKey,
        },
        body: JSON.stringify({ q: query, num: Math.min(limit, 100) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, query },
          "Serper API error",
        );
        return [];
      }

      const data = (await response.json()) as SerperApiResponse;
      const results = data.organic ?? [];

      return results
        .filter((r): r is SerperOrganicResult & { title: string; link: string } =>
          typeof r.title === "string" && typeof r.link === "string",
        )
        .map((r) => ({
          title: r.title,
          url: r.link,
          snippet: r.snippet ?? "",
          published_date: r.date,
        }));
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), query },
        "Serper request failed",
      );
      return [];
    }
  }
}
