import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { createFetchUrlTool } from "../src/tools/fetch-url.js";
import { clearCache, getCached, cacheKey } from "../src/cache.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const tool = createFetchUrlTool();

function parse(input: Record<string, unknown>): ReturnType<typeof tool.parameters.parse> {
  return tool.parameters.parse(input);
}

// ── Fetch helpers ────────────────────────────────────────────

function stubFetch(
  body: string,
  contentType: string,
  status = 200,
): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  }));
}

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── HTML extraction ──────────────────────────────────────────

describe("fetch_url — HTML", () => {
  const HTML_PAGE = `<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
  <nav>Navigation here</nav>
  <article><p>This is the main article content about TypeScript.</p></article>
  <footer>Footer stuff</footer>
</body></html>`;

  it("extracts readable content from HTML", async () => {
    stubFetch(HTML_PAGE, "text/html; charset=utf-8");

    const result = await tool.execute(
      parse({ url: "https://example.com/article" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    const page = JSON.parse(result.content);
    expect(page.title).toBe("Test Page");
    expect(page.content).toContain("TypeScript");
    expect(page.content_type).toBe("text/html");
    expect(page.url).toBe("https://example.com/article");
    expect(page.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("strips nav and footer boilerplate", async () => {
    stubFetch(HTML_PAGE, "text/html");

    const result = await tool.execute(
      parse({ url: "https://example.com/article" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content).not.toContain("Navigation here");
    expect(page.content).not.toContain("Footer stuff");
  });
});

// ── JSON handling ────────────────────────────────────────────

describe("fetch_url — JSON", () => {
  it("formats JSON with indentation", async () => {
    stubFetch('{"key":"value","num":42}', "application/json");

    const result = await tool.execute(
      parse({ url: "https://api.example.com/data" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content).toContain('"key": "value"');
    expect(page.content).toContain('"num": 42');
    expect(page.content_type).toBe("application/json");
  });

  it("returns raw body for malformed JSON", async () => {
    stubFetch("not-json{{{", "application/json");

    const result = await tool.execute(
      parse({ url: "https://api.example.com/broken" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content).toBe("not-json{{{");
  });
});

// ── Plain text ───────────────────────────────────────────────

describe("fetch_url — plain text", () => {
  it("returns text as-is", async () => {
    stubFetch("Hello, world!", "text/plain");

    const result = await tool.execute(
      parse({ url: "https://example.com/hello.txt" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content).toBe("Hello, world!");
    expect(page.content_type).toBe("text/plain");
  });

  it("returns markdown as-is", async () => {
    stubFetch("# Heading\n\nParagraph", "text/markdown");

    const result = await tool.execute(
      parse({ url: "https://example.com/doc.md" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content).toBe("# Heading\n\nParagraph");
  });
});

// ── Truncation ───────────────────────────────────────────────

describe("fetch_url — truncation", () => {
  it("truncates content exceeding ~8000 tokens", async () => {
    const longText = "a".repeat(40_000);
    stubFetch(longText, "text/plain");

    const result = await tool.execute(
      parse({ url: "https://example.com/big" }),
      ctx,
    );

    const page = JSON.parse(result.content);
    expect(page.content.length).toBeLessThan(longText.length);
    expect(page.content).toContain("[…truncated to ~8 000 tokens]");
  });
});

// ── Caching ──────────────────────────────────────────────────

describe("fetch_url — caching", () => {
  it("caches the result and returns it on the second call", async () => {
    stubFetch("cached content", "text/plain");

    const input = parse({ url: "https://example.com/cached" });
    const result1 = await tool.execute(input, ctx);
    const result2 = await tool.execute(input, ctx);

    // fetch should only be called once
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // both results should have the same content
    expect(result1.content).toBe(result2.content);
  });

  it("populates the cache after a successful fetch", async () => {
    stubFetch("data", "text/plain");

    await tool.execute(parse({ url: "https://example.com/store" }), ctx);

    const key = cacheKey("https://example.com/store");
    expect(getCached(key)).not.toBeNull();
  });

  it("does not cache error responses", async () => {
    stubFetch("Not Found", "text/plain", 404);

    const result = await tool.execute(
      parse({ url: "https://example.com/missing" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    const key = cacheKey("https://example.com/missing");
    expect(getCached(key)).toBeNull();
  });
});

// ── Error handling ───────────────────────────────────────────

describe("fetch_url — errors", () => {
  it("returns is_error for HTTP errors", async () => {
    stubFetch("", "text/plain", 500);

    const result = await tool.execute(
      parse({ url: "https://example.com/fail" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("HTTP 500");
  });

  it("returns is_error for network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await tool.execute(
      parse({ url: "https://example.com/down" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("rejects private IP URLs", async () => {
    const result = await tool.execute(
      parse({ url: "http://192.168.1.1/admin" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not allowed");
  });

  it("rejects non-http URLs", async () => {
    const result = await tool.execute(
      parse({ url: "file:///etc/passwd" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
  });
});
