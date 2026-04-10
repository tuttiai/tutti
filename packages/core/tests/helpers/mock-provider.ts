/**
 * Shared test utilities for mocking LLM providers and building fixtures.
 *
 * Usage:
 *   import { createMockProvider, textResponse, toolUseResponse, simpleAgent } from "./helpers/mock-provider.js";
 */

import { vi } from "vitest";
import type {
  AgentConfig,
  ChatResponse,
  LLMProvider,
} from "@tuttiai/types";

/**
 * Creates a mock LLMProvider that returns responses in sequence.
 * The `chat` method is a vitest spy so you can assert on calls.
 */
export function createMockProvider(
  responses: ChatResponse[],
): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  return {
    chat: vi.fn(async () => {
      const response = responses[callIndex];
      if (!response) throw new Error("No more mock responses");
      callIndex++;
      return response;
    }),
  };
}

/**
 * Shorthand: a mock provider that always returns a single text response.
 */
export function createSingleResponseProvider(
  text = "mock response",
): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return createMockProvider([textResponse(text)]);
}

/** Builds a ChatResponse containing a single text block with `end_turn`. */
export function textResponse(text: string): ChatResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Builds a ChatResponse containing a single tool_use block. */
export function toolUseResponse(
  toolName: string,
  input: unknown,
  toolId = "tool-1",
): ChatResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [
      { type: "tool_use", id: toolId, name: toolName, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 15, output_tokens: 10 },
  };
}

/** A minimal agent config with no voices, useful as a base for spread. */
export const simpleAgent: AgentConfig = {
  name: "test-agent",
  model: "test-model",
  system_prompt: "You are a test agent.",
  voices: [],
};
