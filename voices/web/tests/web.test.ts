import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import type { SearchProvider, SearchResult } from "../src/types.js";
import { BraveProvider } from "../src/providers/brave.js";
import { SerperProvider } from "../src/providers/serper.js";
import { DuckDuckGoProvider } from "../src/providers/duckduckgo.js";
import { resolveProvider } from "../src/providers/index.js";
import { createWebSearchTool } from "../src/tools/web-search.js";
import { WebVoice } from "../src/index.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const TIMEOUT = 5_000;

// ── Helpers ──────────────────────────────────────────────────

function mockFetchOk(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  }));
}

function mockFetchError(status: number): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  }));
}

function mockFetchThrow(message: string): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(message)));
}

beforeEach(() => {
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  vi.stubEnv("SERPER_API_KEY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── BraveProvider ────────────────────────────────────────────

describe("BraveProvider", () => {
  const provider = new BraveProvider("test-brave-key", { timeout_ms: TIMEOUT });

  it("returns normalised results from a successful response", async () => {
    mockFetchOk({
      web: {
        results: [
          { title: "Tutti AI", url: "https://tutti-ai.com", description: "Orchestration", page_age: "2026-04-14" },
          { title: "GitHub", url: "https://github.com", description: "Code" },
        ],
      },
    });

    const results = await provider.search("tutti ai", 5);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Tutti AI",
      url: "https://tutti-ai.com",
      snippet: "Orchestration",
      published_date: "2026-04-14",
    });
    expect(results[1]?.published_date).toBeUndefined();
  });

  it("sends the API key in X-Subscription-Token header", async () => {
    mockFetchOk({ web: { results: [] } });
    await provider.search("test", 5);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("test-brave-key");
  });

  it("returns empty array on HTTP error", async () => {
    mockFetchError(500);
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    mockFetchThrow("network down");
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });

  it("filters out results missing title or url", async () => {
    mockFetchOk({
      web: { results: [{ description: "no title or url" }, { title: "OK", url: "https://ok.com" }] },
    });
    const results = await provider.search("test", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("OK");
  });
});

// ── SerperProvider ───────────────────────────────────────────

describe("SerperProvider", () => {
  const provider = new SerperProvider("test-serper-key", { timeout_ms: TIMEOUT });

  it("returns normalised results from a successful response", async () => {
    mockFetchOk({
      organic: [
        { title: "Result 1", link: "https://a.com", snippet: "First", date: "2026-04-14" },
        { title: "Result 2", link: "https://b.com", snippet: "Second" },
      ],
    });

    const results = await provider.search("query", 5);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Result 1",
      url: "https://a.com",
      snippet: "First",
      published_date: "2026-04-14",
    });
  });

  it("POSTs with the API key in X-API-KEY header", async () => {
    mockFetchOk({ organic: [] });
    await provider.search("test", 5);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[1].method).toBe("POST");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("test-serper-key");
  });

  it("returns empty array on HTTP error", async () => {
    mockFetchError(403);
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    mockFetchThrow("timeout");
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });
});

// ── DuckDuckGoProvider ───────────────────────────────────────

describe("DuckDuckGoProvider", () => {
  const provider = new DuckDuckGoProvider({ timeout_ms: TIMEOUT });

  it("returns abstract as the first result", async () => {
    mockFetchOk({
      Heading: "TypeScript",
      Abstract: "A typed superset of JavaScript",
      AbstractURL: "https://en.wikipedia.org/wiki/TypeScript",
      AbstractSource: "Wikipedia",
      RelatedTopics: [],
    });

    const results = await provider.search("typescript", 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "TypeScript",
      url: "https://en.wikipedia.org/wiki/TypeScript",
      snippet: "A typed superset of JavaScript",
    });
  });

  it("includes related topics", async () => {
    mockFetchOk({
      Abstract: "",
      RelatedTopics: [
        { FirstURL: "https://a.com", Text: "Topic A description" },
        { FirstURL: "https://b.com", Text: "Topic B description" },
      ],
    });

    const results = await provider.search("test", 5);
    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe("https://a.com");
  });

  it("flattens nested topic groups", async () => {
    mockFetchOk({
      Abstract: "",
      RelatedTopics: [
        {
          Topics: [
            { FirstURL: "https://nested.com", Text: "Nested topic" },
          ],
        },
      ],
    });

    const results = await provider.search("test", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://nested.com");
  });

  it("respects the limit parameter", async () => {
    mockFetchOk({
      Abstract: "",
      RelatedTopics: [
        { FirstURL: "https://a.com", Text: "A" },
        { FirstURL: "https://b.com", Text: "B" },
        { FirstURL: "https://c.com", Text: "C" },
      ],
    });

    const results = await provider.search("test", 2);
    expect(results).toHaveLength(2);
  });

  it("returns empty array on HTTP error", async () => {
    mockFetchError(500);
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });

  it("returns empty array on network failure", async () => {
    mockFetchThrow("dns failure");
    const results = await provider.search("fail", 5);
    expect(results).toEqual([]);
  });
});

// ── Provider factory ─────────────────────────────────────────

describe("resolveProvider", () => {
  it("selects Brave when BRAVE_SEARCH_API_KEY is set", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "bk");
    vi.stubEnv("SERPER_API_KEY", "sk");
    const provider = resolveProvider();
    expect(provider.name).toBe("brave");
  });

  it("selects Serper when only SERPER_API_KEY is set", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubEnv("SERPER_API_KEY", "sk");
    const provider = resolveProvider();
    expect(provider.name).toBe("serper");
  });

  it("falls back to DuckDuckGo when no keys are set", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubEnv("SERPER_API_KEY", "");
    const provider = resolveProvider();
    expect(provider.name).toContain("duckduckgo");
  });
});

// ── web_search tool ──────────────────────────────────────────

describe("web_search tool", () => {
  it("returns formatted results", async () => {
    const mock: SearchProvider = {
      name: "mock",
      search: vi.fn().mockResolvedValue([
        { title: "Tutti AI", url: "https://tutti-ai.com", snippet: "Orchestration framework" },
      ] satisfies SearchResult[]),
    };

    const tool = createWebSearchTool(mock);
    const input = tool.parameters.parse({ query: "tutti ai" });
    const result = await tool.execute(input, ctx);

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Tutti AI");
    expect(result.content).toContain("https://tutti-ai.com");
    expect(result.content).toContain("via mock");
  });

  it("returns 'No results found' when provider returns empty", async () => {
    const mock: SearchProvider = {
      name: "mock",
      search: vi.fn().mockResolvedValue([]),
    };

    const tool = createWebSearchTool(mock);
    const input = tool.parameters.parse({ query: "nothing" });
    const result = await tool.execute(input, ctx);

    expect(result.content).toBe("No results found.");
  });

  it("passes the limit to the provider", async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    const mock: SearchProvider = { name: "mock", search: searchFn };

    const tool = createWebSearchTool(mock);
    const input = tool.parameters.parse({ query: "test", limit: 10 });
    await tool.execute(input, ctx);

    expect(searchFn).toHaveBeenCalledWith("test", 10);
  });
});

// ── WebVoice class ───────────────────────────────────────────

describe("WebVoice", () => {
  it("implements the Voice interface with 1 tool", () => {
    const voice = new WebVoice({ provider: { name: "stub", search: async () => [] } });
    expect(voice.name).toBe("web");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(1);
    expect(voice.tools[0]?.name).toBe("web_search");
  });

  it("auto-selects provider when no explicit provider is given", () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    vi.stubEnv("SERPER_API_KEY", "");
    const voice = new WebVoice();
    expect(voice.tools).toHaveLength(1);
  });
});
