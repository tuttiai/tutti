/**
 * Unit tests for {@link OpenAIProvider}. Mocks the OpenAI SDK at module
 * boundary — covers request shape, tool mapping, error mapping, and
 * streaming basics.
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

const { OpenAIProvider } = await import("../src/providers/openai.js");
const { AuthenticationError } = await import("../src/errors.js");

beforeEach(() => {
  constructorSpy.mockReset();
  createSpy.mockReset();
});

const baseRequest: ChatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hi" }],
};

const baseUsage = {
  prompt_tokens: 12,
  completion_tokens: 8,
  total_tokens: 20,
};

function chatResponse(content = "Hello") {
  return {
    id: "resp-1",
    choices: [
      {
        message: { content, tool_calls: undefined },
        finish_reason: "stop",
      },
    ],
    usage: baseUsage,
  };
}

describe("OpenAIProvider", () => {
  it("constructs the SDK client with the provided api_key", () => {
    new OpenAIProvider({ api_key: "sk-test" });
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test" }),
    );
  });

  it("returns text content and token usage on chat()", async () => {
    createSpy.mockResolvedValue(chatResponse("Hi back"));
    const provider = new OpenAIProvider({ api_key: "k" });
    const result = await provider.chat(baseRequest);
    expect(result.content).toEqual([{ type: "text", text: "Hi back" }]);
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 8 });
    expect(result.stop_reason).toBe("end_turn");
  });

  it("maps OpenAI tool_calls into tool_use ContentBlocks", async () => {
    createSpy.mockResolvedValue({
      id: "r",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: { name: "ping", arguments: '{"x":1}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: baseUsage,
    });
    const provider = new OpenAIProvider({ api_key: "k" });
    const result = await provider.chat(baseRequest);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: "ping",
      input: { x: 1 },
    });
  });

  it("maps an Incorrect-API-key SDK error to AuthenticationError", async () => {
    createSpy.mockRejectedValue(new Error("Incorrect API key provided: ..."));
    const provider = new OpenAIProvider({ api_key: "k" });
    await expect(provider.chat(baseRequest)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("streams text chunks and yields a final usage chunk", async () => {
    async function* chunks() {
      yield {
        choices: [{ index: 0, delta: { content: "He" }, finish_reason: null }],
      };
      yield {
        choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }],
      };
      yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      yield { choices: [], usage: baseUsage };
    }
    createSpy.mockResolvedValue(chunks());
    const provider = new OpenAIProvider({ api_key: "k" });
    const out: StreamChunk[] = [];
    for await (const c of provider.stream(baseRequest)) out.push(c);
    expect(
      out
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(""),
    ).toBe("Hello");
    expect(out.at(-1)?.type).toBe("usage");
  });
});
