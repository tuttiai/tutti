/**
 * Unit tests for the Anthropic request builder: where prompt-cache
 * breakpoints go, and how the API's usage maps onto Tutti's.
 */

import { describe, it, expect } from "vitest";
import type { ChatRequest } from "@tuttiai/types";

import { buildAnthropicPrompt, toTokenUsage } from "../src/providers/anthropic-request.js";

const tool = { name: "search", description: "Search.", input_schema: { type: "object" } };
const ephemeral = { type: "ephemeral" };

const request: ChatRequest = {
  model: "m",
  system: "You research.",
  tools: [tool, { ...tool, name: "fetch" }],
  messages: [
    { role: "user", content: "Find X" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] },
  ],
};

describe("buildAnthropicPrompt", () => {
  it("marks the end of the system prompt and of the last message", () => {
    const prompt = buildAnthropicPrompt(request);
    expect(prompt.system).toEqual([{ type: "text", text: "You research.", cache_control: ephemeral }]);
    expect(prompt.messages.at(-1)?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "found", cache_control: ephemeral },
    ]);
  });

  it("leaves earlier messages and the tools unmarked when there is a system prompt", () => {
    const prompt = buildAnthropicPrompt(request);
    expect(prompt.messages.at(0)).toEqual({ role: "user", content: "Find X" });
    expect(prompt.tools?.every((t) => t.cache_control === undefined)).toBe(true);
  });

  it("marks the last tool instead when there is no system prompt", () => {
    const prompt = buildAnthropicPrompt({ ...request, system: undefined });
    expect(prompt.system).toBe("");
    expect(prompt.tools?.at(-1)?.cache_control).toEqual(ephemeral);
    expect(prompt.tools?.at(0)?.cache_control).toBeUndefined();
  });

  it("turns a string last message into a marked text block", () => {
    const prompt = buildAnthropicPrompt({ model: "m", messages: [{ role: "user", content: "Hi" }] });
    expect(prompt.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi", cache_control: ephemeral }] },
    ]);
    expect(prompt.tools).toBeUndefined();
  });

  it("leaves an empty last message alone, as the API rejects an empty block", () => {
    const prompt = buildAnthropicPrompt({ model: "m", messages: [{ role: "user", content: "" }] });
    expect(prompt.messages).toEqual([{ role: "user", content: "" }]);
  });
});

describe("toTokenUsage", () => {
  it("counts cached tokens into input and reports them apart", () => {
    expect(toTokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }))
      .toEqual({ input_tokens: 110, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
  });

  it("omits cache figures the API did not report", () => {
    expect(toTokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null }))
      .toEqual({ input_tokens: 10, output_tokens: 5 });
  });
});
