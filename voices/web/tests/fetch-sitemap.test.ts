import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { createFetchSitemapTool } from "../src/tools/fetch-sitemap.js";
import { clearCache } from "../src/cache.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const tool = createFetchSitemapTool();

function parse(input: Record<string, unknown>) {
  return tool.parameters.parse(input);
}

function stubFetch(body: string, status = 200): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
}

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/blog</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetch_sitemap", () => {
  it("extracts URLs from a standard urlset sitemap", async () => {
    stubFetch(SITEMAP_XML);

    const result = await tool.execute(
      parse({ url: "https://example.com/sitemap.xml" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("3 URLs");
    expect(result.content).toContain("https://example.com/about");
    expect(result.content).toContain("https://example.com/blog");
  });

  it("extracts URLs from a sitemap index", async () => {
    stubFetch(SITEMAP_INDEX);

    const result = await tool.execute(
      parse({ url: "https://example.com/sitemap.xml" }),
      ctx,
    );

    expect(result.content).toContain("2 URLs");
    expect(result.content).toContain("sitemap-posts.xml");
    expect(result.content).toContain("sitemap-pages.xml");
  });

  it("appends /sitemap.xml when URL does not end in .xml", async () => {
    stubFetch(SITEMAP_XML);

    await tool.execute(parse({ url: "https://example.com" }), ctx);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [URL];
    expect(call[0].href).toBe("https://example.com/sitemap.xml");
  });

  it("strips trailing slashes before appending /sitemap.xml", async () => {
    stubFetch(SITEMAP_XML);

    await tool.execute(parse({ url: "https://example.com/" }), ctx);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [URL];
    expect(call[0].href).toBe("https://example.com/sitemap.xml");
  });

  it("returns is_error for HTTP errors", async () => {
    stubFetch("Not found", 404);

    const result = await tool.execute(
      parse({ url: "https://example.com/sitemap.xml" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("HTTP 404");
  });

  it("returns is_error for network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await tool.execute(
      parse({ url: "https://example.com/sitemap.xml" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("ECONNREFUSED");
  });

  it("returns 'No URLs found' for empty sitemaps", async () => {
    stubFetch("<urlset></urlset>");

    const result = await tool.execute(
      parse({ url: "https://example.com/sitemap.xml" }),
      ctx,
    );

    expect(result.content).toContain("No URLs found");
  });

  it("caches results on subsequent calls", async () => {
    stubFetch(SITEMAP_XML);

    const input = parse({ url: "https://example.com/sitemap.xml" });
    await tool.execute(input, ctx);
    const r2 = await tool.execute(input, ctx);

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(r2.content).toContain("(cached)");
  });

  it("rejects private IP URLs", async () => {
    const result = await tool.execute(
      parse({ url: "http://192.168.1.1/sitemap.xml" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not allowed");
  });
});
