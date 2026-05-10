/**
 * Unit tests for {@link OpenRouterProvider}.
 *
 * The OpenAI SDK is mocked at the module boundary so no real API calls
 * are made. Tests assert request shape, header forwarding, streaming
 * order, tool-call mapping, cost surfacing via OpenRouter's
 * `usage: { include: true }` extension, and typed-error mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamChunk } from "@tuttiai/types";

const constructorSpy = vi.fn();
const createSpy = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: createSpy } };
    constructor(opts: unknown) {
      constructorSpy(opts);
    }
  }
  return { default: MockOpenAI };
});

// Import after mock so the module under test picks up the mocked SDK.
const { OpenRouterProvider } = await import(
  "../src/providers/openrouter.js"
);
const { AuthenticationError, RateLimitError, ProviderError } = await import(
  "../src/errors.js"
);

beforeEach(() => {
  constructorSpy.mockReset();
  createSpy.mockReset();
});

const baseRequest: ChatRequest = {
  model: "anthropic/claude-sonnet-4",
  messages: [{ role: "user", content: "Hello" }],
};

const baseUsage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  cost: 0.000123,
};

function chatResponse(overrides: Partial<{
  text: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finish_reason: string;
  usage: Record<string, unknown>;
}> = {}) {
  return {
    id: "gen-test-1",
    choices: [
      {
        message: {
          content: overrides.text ?? "Hi there",
          tool_calls: overrides.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          })),
        },
        finish_reason: overrides.finish_reason ?? "stop",
      },
    ],
    usage: overrides.usage ?? baseUsage,
  };
}

describe("OpenRouterProvider", () => {
  describe("construction", () => {
    it("defaults baseURL to https://openrouter.ai/api/v1", () => {
      new OpenRouterProvider({ api_key: "sk-or-test" });
      expect(constructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "sk-or-test",
          baseURL: "https://openrouter.ai/api/v1",
        }),
      );
    });

    it("accepts a custom base_url", () => {
      new OpenRouterProvider({
        api_key: "sk-or-test",
        base_url: "https://proxy.example.com/v1",
      });
      expect(constructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://proxy.example.com/v1" }),
      );
    });

    it("forwards http_referer and x_title as defaultHeaders", () => {
      new OpenRouterProvider({
        api_key: "sk-or-test",
        http_referer: "https://my.app",
        x_title: "My App",
      });
      expect(constructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: {
            "HTTP-Referer": "https://my.app",
            "X-Title": "My App",
          },
        }),
      );
    });

    it("omits defaultHeaders entirely when neither attribution field is set", () => {
      new OpenRouterProvider({ api_key: "sk-or-test" });
      const opts = constructorSpy.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(opts).not.toHaveProperty("defaultHeaders");
    });

    it("falls back to OPENROUTER_API_KEY env var via SecretsManager", () => {
      const original = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = "sk-or-from-env";
      try {
        new OpenRouterProvider();
        expect(constructorSpy).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: "sk-or-from-env" }),
        );
      } finally {
        if (original === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = original;
      }
    });
  });

  describe("chat()", () => {
    it("throws ProviderError when no model is provided", async () => {
      const provider = new OpenRouterProvider({ api_key: "k" });
      await expect(
        provider.chat({ ...baseRequest, model: undefined }),
      ).rejects.toBeInstanceOf(ProviderError);
    });

    it("requests usage.include for inline cost reporting", async () => {
      createSpy.mockResolvedValue(chatResponse());
      const provider = new OpenRouterProvider({ api_key: "k" });
      await provider.chat(baseRequest);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { include: true } }),
      );
    });

    it("forwards route and models when configured", async () => {
      createSpy.mockResolvedValue(chatResponse());
      const provider = new OpenRouterProvider({
        api_key: "k",
        route: "fallback",
        models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
      });
      await provider.chat(baseRequest);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          route: "fallback",
          models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
        }),
      );
    });

    it("does not include route or models when unset", async () => {
      createSpy.mockResolvedValue(chatResponse());
      const provider = new OpenRouterProvider({ api_key: "k" });
      await provider.chat(baseRequest);
      const body = createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body).not.toHaveProperty("route");
      expect(body).not.toHaveProperty("models");
    });

    it("maps text response to a text ContentBlock", async () => {
      createSpy.mockResolvedValue(chatResponse({ text: "Hello world" }));
      const provider = new OpenRouterProvider({ api_key: "k" });
      const result = await provider.chat(baseRequest);
      expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(result.stop_reason).toBe("end_turn");
    });

    it("maps tool_calls to tool_use ContentBlocks", async () => {
      createSpy.mockResolvedValue(
        chatResponse({
          text: "",
          finish_reason: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              name: "search",
              args: '{"q":"tutti"}',
            },
          ],
        }),
      );
      const provider = new OpenRouterProvider({ api_key: "k" });
      const result = await provider.chat(baseRequest);
      expect(result.stop_reason).toBe("tool_use");
      expect(result.content).toContainEqual({
        type: "tool_use",
        id: "call_1",
        name: "search",
        input: { q: "tutti" },
      });
    });

    it("surfaces OpenRouter cost via usage.cost_usd", async () => {
      createSpy.mockResolvedValue(chatResponse());
      const provider = new OpenRouterProvider({ api_key: "k" });
      const result = await provider.chat(baseRequest);
      expect(result.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.000123,
      });
    });

    it("omits cost_usd when OpenRouter does not return it", async () => {
      createSpy.mockResolvedValue(
        chatResponse({
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      const provider = new OpenRouterProvider({ api_key: "k" });
      const result = await provider.chat(baseRequest);
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
      expect(result.usage.cost_usd).toBeUndefined();
    });

    it("forwards tool definitions in the request", async () => {
      createSpy.mockResolvedValue(chatResponse());
      const provider = new OpenRouterProvider({ api_key: "k" });
      await provider.chat({
        ...baseRequest,
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      });
      const body = createSpy.mock.calls[0]?.[0] as {
        tools?: Array<{ type: string; function: { name: string } }>;
      };
      expect(body.tools).toHaveLength(1);
      expect(body.tools?.[0]).toEqual({
        type: "function",
        function: {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      });
    });
  });

  describe("error mapping", () => {
    it("maps 401 to AuthenticationError", async () => {
      createSpy.mockRejectedValue(
        Object.assign(new Error("Invalid API key"), { status: 401 }),
      );
      const provider = new OpenRouterProvider({ api_key: "k" });
      await expect(provider.chat(baseRequest)).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it("maps 429 to RateLimitError and parses Retry-After", async () => {
      createSpy.mockRejectedValue(
        Object.assign(new Error("Rate limited"), {
          status: 429,
          headers: { "retry-after": "12" },
        }),
      );
      const provider = new OpenRouterProvider({ api_key: "k" });
      try {
        await provider.chat(baseRequest);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect((err as RateLimitError).retryAfter).toBe(12);
      }
    });

    it("maps unknown errors to ProviderError preserving status", async () => {
      createSpy.mockRejectedValue(
        Object.assign(new Error("Service unavailable"), { status: 503 }),
      );
      const provider = new OpenRouterProvider({ api_key: "k" });
      try {
        await provider.chat(baseRequest);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect(err).not.toBeInstanceOf(AuthenticationError);
        expect(err).not.toBeInstanceOf(RateLimitError);
      }
    });

    it("throws ProviderError when response has no choices", async () => {
      createSpy.mockResolvedValue({ id: "x", choices: [], usage: baseUsage });
      const provider = new OpenRouterProvider({ api_key: "k" });
      await expect(provider.chat(baseRequest)).rejects.toBeInstanceOf(
        ProviderError,
      );
    });
  });

  describe("stream()", () => {
    async function* streamChunks() {
      yield {
        choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }],
      };
      yield {
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
      };
      yield {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      yield { choices: [], usage: baseUsage };
    }

    async function* streamWithToolCall() {
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_42",
                  function: { name: "lookup", arguments: '{"q":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }],
            },
            finish_reason: null,
          },
        ],
      };
      yield {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      };
      yield { choices: [], usage: baseUsage };
    }

    async function collect(
      iter: AsyncIterable<StreamChunk>,
    ): Promise<StreamChunk[]> {
      const out: StreamChunk[] = [];
      for await (const c of iter) out.push(c);
      return out;
    }

    it("yields text chunks in order followed by a final usage chunk", async () => {
      createSpy.mockResolvedValue(streamChunks());
      const provider = new OpenRouterProvider({ api_key: "k" });
      const chunks = await collect(provider.stream(baseRequest));
      const textChunks = chunks.filter((c) => c.type === "text");
      expect(textChunks.map((c) => c.text).join("")).toBe("Hello");
      const usageChunk = chunks.at(-1);
      expect(usageChunk?.type).toBe("usage");
      expect(usageChunk?.stop_reason).toBe("end_turn");
      expect(usageChunk?.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.000123,
      });
    });

    it("requests stream + usage.include for streaming runs", async () => {
      createSpy.mockResolvedValue(streamChunks());
      const provider = new OpenRouterProvider({ api_key: "k" });
      await collect(provider.stream(baseRequest));
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
          usage: { include: true },
        }),
      );
    });

    it("yields a tool_use chunk after finish_reason='tool_calls'", async () => {
      createSpy.mockResolvedValue(streamWithToolCall());
      const provider = new OpenRouterProvider({ api_key: "k" });
      const chunks = await collect(provider.stream(baseRequest));
      const toolChunk = chunks.find((c) => c.type === "tool_use");
      expect(toolChunk?.tool).toEqual({
        id: "call_42",
        name: "lookup",
        input: { q: "hi" },
      });
      expect(chunks.at(-1)?.type).toBe("usage");
      expect(chunks.at(-1)?.stop_reason).toBe("tool_use");
    });
  });
});
