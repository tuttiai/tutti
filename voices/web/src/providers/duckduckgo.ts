import { createLogger } from "@tuttiai/core";
import type { SearchResult, SearchProvider, ProviderOptions } from "../types.js";

const logger = createLogger("tutti-web-ddg");

const DDG_API_URL = "https://api.duckduckgo.com/";

/**
 * DuckDuckGo Instant Answer API response — only the fields we use.
 *
 * @remarks
 * The Instant Answer API is free and keyless but returns limited
 * results (usually 0–4 related topics). It is best-effort and should
 * be treated as a "free tier" fallback.
 *
 * @see https://api.duckduckgo.com/api
 */
interface DdgRelatedTopic {
  FirstURL?: string;
  Text?: string;
}

interface DdgApiResponse {
  Abstract?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Heading?: string;
  RelatedTopics?: (DdgRelatedTopic | { Topics?: DdgRelatedTopic[] })[];
}

/**
 * Search provider backed by the DuckDuckGo Instant Answer API.
 *
 * No API key required. Results are limited compared to paid providers
 * and should be labelled as "free tier" in documentation.
 */
export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo (free tier)";
  private readonly timeoutMs: number;

  constructor(options: ProviderOptions) {
    this.timeoutMs = options.timeout_ms;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = new URL(DDG_API_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "tuttiai-web/0.1" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, query },
          "DuckDuckGo API error",
        );
        return [];
      }

      const data = (await response.json()) as DdgApiResponse;
      const results: SearchResult[] = [];

      // The abstract itself (e.g. Wikipedia summary)
      if (data.Abstract && data.AbstractURL) {
        results.push({
          title: data.Heading ?? data.AbstractSource ?? "Abstract",
          url: data.AbstractURL,
          snippet: data.Abstract,
        });
      }

      // Related topics — flatten nested topic groups
      for (const item of data.RelatedTopics ?? []) {
        if (results.length >= limit) break;

        if ("Topics" in item && Array.isArray(item.Topics)) {
          for (const sub of item.Topics) {
            if (results.length >= limit) break;
            if (sub.FirstURL && sub.Text) {
              results.push({
                title: sub.Text.slice(0, 120),
                url: sub.FirstURL,
                snippet: sub.Text,
              });
            }
          }
        } else if ("FirstURL" in item && item.FirstURL && item.Text) {
          results.push({
            title: item.Text.slice(0, 120),
            url: item.FirstURL,
            snippet: item.Text,
          });
        }
      }

      return results.slice(0, limit);
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), query },
        "DuckDuckGo request failed",
      );
      return [];
    }
  }
}
