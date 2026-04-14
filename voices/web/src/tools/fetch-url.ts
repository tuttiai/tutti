import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { createLogger } from "@tuttiai/core";
import type { Tool, ToolResult } from "@tuttiai/types";
import { assertSafeUrl } from "../utils/url-guard.js";
import { cacheKey, getCached, setCached, FETCH_TTL_MS } from "../cache.js";

const logger = createLogger("tutti-web-fetch");

/** Default fetch timeout. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Rough token-to-character ratio (1 token ≈ 4 chars for English).
 * Used to truncate content to a budget the LLM can consume.
 */
const MAX_TOKENS = 8_000;
const MAX_CHARS = MAX_TOKENS * 4;

const parameters = z.object({
  url: z.string().url().describe("URL to fetch"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("HTTP timeout in ms (default 10 000)"),
});

type FetchUrlInput = z.infer<typeof parameters>;

/** Shape returned inside the tool's content string (JSON-encoded). */
interface FetchedPage {
  url: string;
  title: string;
  content: string;
  content_type: string;
  fetched_at: string;
}

/**
 * Truncate a string to at most `max` characters, appending a marker
 * if anything was cut.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n[…truncated to ~8 000 tokens]";
}

/**
 * Detect the broad content category from a Content-Type header value.
 */
function classifyContentType(header: string | null): "html" | "json" | "text" {
  const ct = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct.includes("html")) return "html";
  if (ct.includes("json")) return "json";
  return "text";
}

/**
 * Extract the readable article body from raw HTML using Readability.
 */
function extractArticle(html: string, url: string): { title: string; content: string } {
  const { document } = parseHTML(html);
  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();

  return {
    title: article?.title ?? new URL(url).hostname,
    content: article?.textContent?.trim() ?? "",
  };
}

/**
 * Create the `fetch_url` tool.
 *
 * Fetches a URL, detects content type, extracts readable text for
 * HTML, and truncates the result to ~8 000 tokens.
 */
export function createFetchUrlTool(): Tool<FetchUrlInput> {
  return {
    name: "fetch_url",
    description:
      "Fetch a web page or API endpoint and return its content. " +
      "HTML is cleaned to readable text; JSON is formatted.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      const key = cacheKey(input.url);
      const cached = getCached<FetchedPage>(key);
      if (cached) {
        return { content: JSON.stringify(cached) };
      }

      try {
        const parsed = assertSafeUrl(input.url);
        const timeoutMs = input.timeout_ms ?? FETCH_TIMEOUT_MS;

        const response = await fetch(parsed, {
          redirect: "follow",
          headers: {
            "User-Agent": "tuttiai-web/0.1",
            "Accept": "text/html, application/json, text/plain, */*",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          return {
            content: `HTTP ${response.status} fetching ${input.url}`,
            is_error: true,
          };
        }

        const rawCt = response.headers.get("content-type");
        const kind = classifyContentType(rawCt);
        const body = await response.text();

        let title = parsed.hostname;
        let content: string;
        const contentType = rawCt?.split(";")[0]?.trim() ?? "text/plain";

        switch (kind) {
          case "html": {
            const article = extractArticle(body, input.url);
            title = article.title;
            content = article.content;
            break;
          }
          case "json": {
            try {
              content = JSON.stringify(JSON.parse(body), null, 2);
            } catch {
              content = body;
            }
            break;
          }
          default:
            content = body;
        }

        const page: FetchedPage = {
          url: input.url,
          title,
          content: truncate(content, MAX_CHARS),
          content_type: contentType,
          fetched_at: new Date().toISOString(),
        };

        setCached(key, page, FETCH_TTL_MS);

        return { content: JSON.stringify(page) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ url: input.url, error: message }, "fetch_url failed");
        return { content: "Failed to fetch " + input.url + ": " + message, is_error: true };
      }
    },
  };
}
