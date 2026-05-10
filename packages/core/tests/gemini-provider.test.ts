/**
 * Unit tests for {@link GeminiProvider}. Mocks `@google/generative-ai`
 * at module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamChunk } from "@tuttiai/types";

const constructorSpy = vi.fn();
const generateContentSpy = vi.fn();
const generateContentStreamSpy = vi.fn();
const getGenerativeModelSpy = vi.fn();

vi.mock("@google/generative-ai", () => {
  class MockGoogleGenerativeAI {
    constructor(apiKey: string) {
      constructorSpy(apiKey);
    }
    getGenerativeModel(opts: unknown) {
      getGenerativeModelSpy(opts);
      return {
        generateContent: generateContentSpy,
        generateContentStream: generateContentStreamSpy,
      };
    }
  }
  const SchemaType = {
    STRING: "string",
    NUMBER: "number",
    INTEGER: "integer",
    BOOLEAN: "boolean",
    ARRAY: "array",
    OBJECT: "object",
  };
  return { GoogleGenerativeAI: MockGoogleGenerativeAI, SchemaType };
});

const { GeminiProvider } = await import("../src/providers/gemini.js");
const { AuthenticationError } = await import("../src/errors.js");

beforeEach(() => {
  constructorSpy.mockReset();
  generateContentSpy.mockReset();
  generateContentStreamSpy.mockReset();
  getGenerativeModelSpy.mockReset();
});

const baseRequest: ChatRequest = {
  model: "gemini-2.0-flash",
  messages: [{ role: "user", content: "Hi" }],
};

describe("GeminiProvider", () => {
  it("throws AuthenticationError when no api_key is provided", () => {
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(() => new GeminiProvider()).toThrow(AuthenticationError);
    } finally {
      if (original !== undefined) process.env.GEMINI_API_KEY = original;
    }
  });

  it("constructs the SDK client with the provided api_key", () => {
    new GeminiProvider({ api_key: "AIzaTest" });
    expect(constructorSpy).toHaveBeenCalledWith("AIzaTest");
  });

  it("returns text content and token usage on chat()", async () => {
    generateContentSpy.mockResolvedValue({
      response: {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      },
    });
    const provider = new GeminiProvider({ api_key: "AIzaTest" });
    const result = await provider.chat(baseRequest);
    expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("maps a functionCall response to a tool_use ContentBlock", async () => {
    generateContentSpy.mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "search", args: { q: "tutti" } } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8 },
      },
    });
    const provider = new GeminiProvider({ api_key: "AIzaTest" });
    const result = await provider.chat(baseRequest);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toContainEqual({
      type: "tool_use",
      id: "search",
      name: "search",
      input: { q: "tutti" },
    });
  });

  it("streams text and yields a final usage chunk", async () => {
    async function* stream() {
      yield { candidates: [{ content: { parts: [{ text: "Hi " }] } }] };
      yield { candidates: [{ content: { parts: [{ text: "there" }] } }] };
    }
    generateContentStreamSpy.mockResolvedValue({
      stream: stream(),
      response: Promise.resolve({
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5 },
      }),
    });
    const provider = new GeminiProvider({ api_key: "AIzaTest" });
    const out: StreamChunk[] = [];
    for await (const c of provider.stream(baseRequest)) out.push(c);
    expect(
      out
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
    ).toBe("Hi there");
    expect(out.at(-1)).toEqual({
      type: "usage",
      usage: { input_tokens: 6, output_tokens: 5 },
      stop_reason: "end_turn",
    });
  });
});
