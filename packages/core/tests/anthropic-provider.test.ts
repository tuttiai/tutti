/**
 * Unit tests for {@link AnthropicProvider}. Mocks `@anthropic-ai/sdk`
 * at module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamChunk } from "@tuttiai/types";

const constructorSpy = vi.fn();
const createSpy = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: createSpy };
    constructor(opts: unknown) {
      constructorSpy(opts);
    }
  }
  return { default: MockAnthropic };
});

const { AnthropicProvider } = await import("../src/providers/anthropic.js");
const { AuthenticationError, ProviderError } = await import(
  "../src/errors.js"
);

beforeEach(() => {
  constructorSpy.mockReset();
  createSpy.mockReset();
});

const baseRequest: ChatRequest = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hi" }],
};

describe("AnthropicProvider", () => {
  it("constructs the SDK client with the provided api_key", () => {
    new AnthropicProvider({ api_key: "sk-ant-test" });
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test" }),
    );
  });

  it("throws ProviderError when no model is provided", async () => {
    const provider = new AnthropicProvider({ api_key: "k" });
    await expect(
      provider.chat({ ...baseRequest, model: undefined }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps text + tool_use response blocks to ContentBlocks", async () => {
    createSpy.mockResolvedValue({
      id: "msg-1",
      content: [
        { type: "text", text: "Looking up..." },
        { type: "tool_use", id: "tu-1", name: "search", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 12 },
    });
    const provider = new AnthropicProvider({ api_key: "k" });
    const result = await provider.chat(baseRequest);
    expect(result.content).toEqual([
      { type: "text", text: "Looking up..." },
      { type: "tool_use", id: "tu-1", name: "search", input: { q: "x" } },
    ]);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 12 });
  });

  it("maps an authentication error to AuthenticationError", async () => {
    createSpy.mockRejectedValue(new Error("authentication_error: invalid x-api-key"));
    const provider = new AnthropicProvider({ api_key: "k" });
    await expect(provider.chat(baseRequest)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("streams text deltas and yields a final usage chunk", async () => {
    async function* events() {
      yield {
        type: "message_start",
        message: { usage: { input_tokens: 25, output_tokens: 0 } },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi " },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "there" },
      };
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      };
    }
    createSpy.mockResolvedValue(events());
    const provider = new AnthropicProvider({ api_key: "k" });
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
      usage: { input_tokens: 25, output_tokens: 9 },
      stop_reason: "end_turn",
    });
  });
});
