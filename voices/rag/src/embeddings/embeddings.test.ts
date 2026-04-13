import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} from "./index.js";
import { batch, isRetryable, normalize, EmbeddingRequestError } from "./utils.js";
import type { EmbeddingConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Install a `fetch` stub that returns the next queued response for each call.
 * Every call's URL + init are recorded so tests can assert shape.
 */
function mockFetch(
  responses: Array<() => Response | Promise<Response>>,
): { calls: MockCall[]; fn: typeof fetch } {
  const calls: MockCall[] = [];
  let i = 0;
  const fn: typeof fetch = vi.fn((input: RequestInfo | URL, init) => {
    // RequestInfo = Request | string. URL.toString() and Request.url are
    // the only well-defined stringifications; the bare base toString on a
    // Request would yield "[object Request]".
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    const next = responses[i++];
    if (!next) {
      return Promise.reject(new Error("mockFetch: no more responses queued"));
    }
    return Promise.resolve(next());
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

/**
 * Advance fake timers through three backoff windows (500, 1000, 2000 ms).
 * Works even if the awaited attempt has already resolved.
 */
async function flushBackoff(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(2000);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// utils
// ===========================================================================

describe("utils", () => {
  it("batch splits into windows", () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batch([], 10)).toEqual([]);
  });

  it("batch rejects non-positive sizes", () => {
    expect(() => batch([1], 0)).toThrow(/positive/);
  });

  it("normalize scales to unit length", () => {
    const v = normalize([3, 4]);
    expect(v[0]).toBeCloseTo(0.6, 10);
    expect(v[1]).toBeCloseTo(0.8, 10);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 10);
  });

  it("normalize leaves zero vectors unchanged", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("isRetryable flags 408/429/5xx", () => {
    expect(isRetryable(new EmbeddingRequestError("x", 429))).toBe(true);
    expect(isRetryable(new EmbeddingRequestError("x", 408))).toBe(true);
    expect(isRetryable(new EmbeddingRequestError("x", 503))).toBe(true);
    expect(isRetryable(new EmbeddingRequestError("x", 400))).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
    expect(isRetryable(new TypeError("network"))).toBe(true);
  });
});

// ===========================================================================
// Factory
// ===========================================================================

describe("createEmbeddingProvider", () => {
  it("dispatches to OpenAIEmbeddingProvider", () => {
    const provider = createEmbeddingProvider({
      collection: "c",
      embeddings: { provider: "openai", api_key: "sk-test" },
    });
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(provider.name).toBe("openai");
  });

  it("dispatches to AnthropicEmbeddingProvider", () => {
    const provider = createEmbeddingProvider({
      collection: "c",
      embeddings: { provider: "anthropic", api_key: "vy-test" },
    });
    expect(provider).toBeInstanceOf(AnthropicEmbeddingProvider);
    expect(provider.name).toBe("anthropic");
  });

  it("dispatches to LocalEmbeddingProvider", () => {
    const provider = createEmbeddingProvider({
      collection: "c",
      embeddings: {
        provider: "local",
        base_url: "https://ollama.example.com",
        model: "nomic-embed-text",
      },
    });
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
  });

  it("throws when embeddings config is missing", () => {
    expect(() => createEmbeddingProvider({ collection: "c" })).toThrow(
      /embeddings is required/,
    );
  });

  it("rejects unknown provider discriminators", () => {
    const bad = {
      provider: "cohere",
      api_key: "x",
    } as unknown as EmbeddingConfig;
    expect(() =>
      createEmbeddingProvider({ collection: "c", embeddings: bad }),
    ).toThrow();
  });
});

// ===========================================================================
// OpenAI provider
// ===========================================================================

describe("OpenAIEmbeddingProvider", () => {
  it("posts inputs and returns normalised vectors", async () => {
    const { calls } = mockFetch([
      () =>
        jsonResponse({
          data: [
            { index: 0, embedding: [3, 4] },
            { index: 1, embedding: [0, 5] },
          ],
          model: "text-embedding-3-small",
        }),
    ]);

    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk-test",
    });
    const vectors = await provider.embed(["hello", "world"]);

    expect(vectors).toHaveLength(2);
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 10);
    expect(Math.hypot(...vectors[1])).toBeCloseTo(1, 10);

    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0].init!.body as string) as {
      model: string;
      input: string[];
    };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello", "world"]);
  });

  it("reorders responses by index", async () => {
    mockFetch([
      () =>
        jsonResponse({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
          model: "m",
        }),
    ]);
    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    const [first, second] = await provider.embed(["a", "b"]);
    expect(first).toEqual([1, 0]);
    expect(second).toEqual([0, 1]);
  });

  it("splits inputs above the 2048 batch limit", async () => {
    const inputs = Array.from({ length: 2050 }, (_, i) => "t" + i);
    const { calls } = mockFetch([
      () =>
        jsonResponse({
          data: Array.from({ length: 2048 }, (_, i) => ({
            index: i,
            embedding: [1, 0],
          })),
          model: "m",
        }),
      () =>
        jsonResponse({
          data: Array.from({ length: 2 }, (_, i) => ({
            index: i,
            embedding: [1, 0],
          })),
          model: "m",
        }),
    ]);

    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    const vectors = await provider.embed(inputs);

    expect(vectors).toHaveLength(2050);
    expect(calls).toHaveLength(2);
    const b0 = JSON.parse(calls[0].init!.body as string) as { input: string[] };
    const b1 = JSON.parse(calls[1].init!.body as string) as { input: string[] };
    expect(b0.input).toHaveLength(2048);
    expect(b1.input).toHaveLength(2);
  });

  it("retries on 429 and succeeds", async () => {
    vi.useFakeTimers();
    const { calls, fn } = mockFetch([
      () => textResponse("rate limited", 429),
      () =>
        jsonResponse({
          data: [{ index: 0, embedding: [1, 0] }],
          model: "m",
        }),
    ]);

    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    const promise = provider.embed(["a"]);
    await flushBackoff();
    const vectors = await promise;

    expect(vectors).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("gives up after 3 attempts on persistent 429", async () => {
    vi.useFakeTimers();
    const { fn } = mockFetch([
      () => textResponse("rate limited", 429),
      () => textResponse("rate limited", 429),
      () => textResponse("rate limited", 429),
    ]);

    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    const promise = provider.embed(["a"]).catch((e: unknown) => e);
    await flushBackoff();
    const result = await promise;

    expect(result).toBeInstanceOf(EmbeddingRequestError);
    expect((result as EmbeddingRequestError).status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 400", async () => {
    const { fn } = mockFetch([() => textResponse("bad request", 400)]);

    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns [] for empty input without calling fetch", async () => {
    const { fn } = mockFetch([]);
    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      api_key: "sk",
    });
    expect(await provider.embed([])).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws when api_key is empty", () => {
    expect(
      () =>
        new OpenAIEmbeddingProvider({ provider: "openai", api_key: "" }),
    ).toThrow(/api_key/);
  });
});

// ===========================================================================
// Anthropic (Voyage) provider
// ===========================================================================

describe("AnthropicEmbeddingProvider", () => {
  it("calls the Voyage endpoint with voyage-3-lite by default", async () => {
    const { calls } = mockFetch([
      () =>
        jsonResponse({
          data: [{ index: 0, embedding: [1, 0, 0] }],
          model: "voyage-3-lite",
        }),
    ]);

    const provider = new AnthropicEmbeddingProvider({
      provider: "anthropic",
      api_key: "vy-test",
    });
    const vectors = await provider.embed(["hi"]);

    expect(vectors).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    const body = JSON.parse(calls[0].init!.body as string) as {
      model: string;
    };
    expect(body.model).toBe("voyage-3-lite");
  });

  it("splits above the 128 batch cap", async () => {
    const inputs = Array.from({ length: 200 }, (_, i) => "t" + i);
    const { calls } = mockFetch([
      () =>
        jsonResponse({
          data: Array.from({ length: 128 }, (_, i) => ({
            index: i,
            embedding: [1],
          })),
          model: "voyage-3-lite",
        }),
      () =>
        jsonResponse({
          data: Array.from({ length: 72 }, (_, i) => ({
            index: i,
            embedding: [1],
          })),
          model: "voyage-3-lite",
        }),
    ]);

    const provider = new AnthropicEmbeddingProvider({
      provider: "anthropic",
      api_key: "vy",
    });
    await provider.embed(inputs);
    expect(calls).toHaveLength(2);
  });

  it("retries on rate limit", async () => {
    vi.useFakeTimers();
    const { fn } = mockFetch([
      () => textResponse("slow down", 429),
      () =>
        jsonResponse({
          data: [{ index: 0, embedding: [1, 0] }],
          model: "m",
        }),
    ]);

    const provider = new AnthropicEmbeddingProvider({
      provider: "anthropic",
      api_key: "vy",
    });
    const promise = provider.embed(["a"]);
    await flushBackoff();
    await promise;

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// Local (Ollama) provider
// ===========================================================================

describe("LocalEmbeddingProvider", () => {
  it("posts one request per text to /api/embeddings", async () => {
    const { calls } = mockFetch([
      () => jsonResponse({ embedding: [3, 4] }),
      () => jsonResponse({ embedding: [0, 1] }),
    ]);

    const provider = new LocalEmbeddingProvider({
      provider: "local",
      base_url: "https://ollama.example.com",
      model: "nomic-embed-text",
    });
    const vectors = await provider.embed(["a", "b"]);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://ollama.example.com/api/embeddings");
    const body = JSON.parse(calls[0].init!.body as string) as {
      model: string;
      prompt: string;
    };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.prompt).toBe("a");
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 10);
    expect(provider.dimensions).toBe(2);
  });

  it("trims a trailing slash on base_url", async () => {
    const { calls } = mockFetch([
      () => jsonResponse({ embedding: [1, 0] }),
    ]);
    const provider = new LocalEmbeddingProvider({
      provider: "local",
      base_url: "https://ollama.example.com/",
      model: "nomic-embed-text",
    });
    await provider.embed(["x"]);
    expect(calls[0].url).toBe("https://ollama.example.com/api/embeddings");
  });

  it("rejects loopback URLs by default", () => {
    expect(
      () =>
        new LocalEmbeddingProvider({
          provider: "local",
          base_url: "http://localhost:11434",
          model: "nomic-embed-text",
        }),
    ).toThrow(/loopback|private/i);
  });

  it("accepts loopback URLs with allow_private", async () => {
    mockFetch([() => jsonResponse({ embedding: [1, 0] })]);
    const provider = new LocalEmbeddingProvider({
      provider: "local",
      base_url: "http://localhost:11434",
      model: "nomic-embed-text",
      allow_private: true,
    });
    const vectors = await provider.embed(["x"]);
    expect(vectors).toHaveLength(1);
  });

  it("throws when response is missing an embedding array", async () => {
    mockFetch([() => jsonResponse({})]);
    const provider = new LocalEmbeddingProvider({
      provider: "local",
      base_url: "https://ollama.example.com",
      model: "nomic-embed-text",
    });
    await expect(provider.embed(["x"])).rejects.toBeInstanceOf(
      EmbeddingRequestError,
    );
  });

  it("throws when base_url is empty", () => {
    expect(
      () =>
        new LocalEmbeddingProvider({
          provider: "local",
          base_url: "",
          model: "m",
        }),
    ).toThrow(/base_url/);
  });
});
