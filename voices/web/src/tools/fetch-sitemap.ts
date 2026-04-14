import { z } from "zod";
import { createLogger } from "@tuttiai/core";
import type { Tool, ToolResult } from "@tuttiai/types";
import { assertSafeUrl } from "../utils/url-guard.js";
import { cacheKey, getCached, setCached, FETCH_TTL_MS } from "../cache.js";

const logger = createLogger("tutti-web-sitemap");

const SITEMAP_TIMEOUT_MS = 10_000;

const parameters = z.object({
  url: z
    .string()
    .url()
    .describe("URL of a sitemap.xml file (or the site root — /sitemap.xml is appended)"),
});

type FetchSitemapInput = z.infer<typeof parameters>;

/**
 * Extract `<loc>` entries from a sitemap XML string.
 *
 * Handles both `<urlset>` sitemaps and `<sitemapindex>` index files.
 * Uses a lightweight regex approach — no XML parser needed for this
 * well-defined subset.
 */
function extractUrls(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi);
  const urls: string[] = [];
  for (const m of matches) {
    const href = m[1]?.trim();
    if (href) urls.push(href);
  }
  return urls;
}

/**
 * Create the `fetch_sitemap` tool.
 *
 * Fetches a sitemap.xml and returns all URLs listed in it.
 */
export function createFetchSitemapTool(): Tool<FetchSitemapInput> {
  return {
    name: "fetch_sitemap",
    description:
      "Fetch a sitemap.xml and return all URLs listed in it. " +
      "If the URL doesn't end in .xml, /sitemap.xml is appended.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      const raw = input.url.endsWith(".xml")
        ? input.url
        : input.url.replace(/\/+$/, "") + "/sitemap.xml";

      const key = cacheKey("sitemap", raw);
      const cached = getCached<string[]>(key);
      if (cached) {
        return { content: formatSitemap(cached, raw, true) };
      }

      try {
        const parsed = assertSafeUrl(raw);

        const response = await fetch(parsed, {
          redirect: "follow",
          headers: { "User-Agent": "tuttiai-web/0.1" },
          signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
        });

        if (!response.ok) {
          return {
            content: `HTTP ${response.status} fetching ${raw}`,
            is_error: true,
          };
        }

        const body = await response.text();
        const urls = extractUrls(body);

        if (urls.length > 0) {
          setCached(key, urls, FETCH_TTL_MS);
        }

        return { content: formatSitemap(urls, raw, false) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ url: raw, error: message }, "fetch_sitemap failed");
        return {
          content: "Failed to fetch sitemap " + raw + ": " + message,
          is_error: true,
        };
      }
    },
  };
}

function formatSitemap(urls: string[], source: string, fromCache: boolean): string {
  if (urls.length === 0) {
    return "No URLs found in " + source;
  }
  const label = fromCache ? " (cached)" : "";
  const list = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");
  return `${urls.length} URLs from ${source}${label}:\n\n${list}`;
}
