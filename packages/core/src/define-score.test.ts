import { describe, it, expect } from "vitest";
import { defineScore } from "./define-score.js";
import type { ScoreConfig, LLMProvider, ChatRequest, ChatResponse } from "@tuttiai/types";

const mockProvider: LLMProvider = {
  chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
    id: "test",
    content: [{ type: "text", text: "mock" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  }),
};

describe("defineScore", () => {
  it("returns the exact config passed in (identity function)", () => {
    const config: ScoreConfig = {
      name: "test-score",
      provider: mockProvider,
      agents: {
        assistant: {
          name: "assistant",
          model: "test-model",
          system_prompt: "You are helpful.",
          voices: [],
        },
      },
    };

    const result = defineScore(config);
    expect(result).toBe(config);
  });

  it("preserves all fields including optional ones", () => {
    const config: ScoreConfig = {
      name: "full-score",
      description: "A full test config",
      provider: mockProvider,
      default_model: "claude-sonnet-4-20250514",
      agents: {
        agent1: {
          name: "agent1",
          system_prompt: "prompt",
          voices: [],
          max_turns: 5,
        },
      },
    };

    const result = defineScore(config);
    expect(result.description).toBe("A full test config");
    expect(result.default_model).toBe("claude-sonnet-4-20250514");
    expect(result.agents.agent1.max_turns).toBe(5);
  });

  it("works with minimal config (no optional fields)", () => {
    const config: ScoreConfig = {
      provider: mockProvider,
      agents: {
        bot: {
          name: "bot",
          system_prompt: "hi",
          voices: [],
        },
      },
    };

    const result = defineScore(config);
    expect(result.name).toBeUndefined();
    expect(result.agents.bot.model).toBeUndefined();
  });
});
