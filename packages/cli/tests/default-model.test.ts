import { describe, it, expect } from "vitest";
import type { AgentConfig } from "@tuttiai/core";
import { CLI_DEFAULT_MODEL, withDefaultModel } from "../src/default-model.js";

const agent: AgentConfig = {
  name: "Assistant",
  system_prompt: "You are a helpful assistant.",
  voices: [],
};

describe("withDefaultModel", () => {
  it("falls back to claude-sonnet-5-5 when no model is set anywhere", () => {
    expect(CLI_DEFAULT_MODEL).toBe("claude-sonnet-5-5");
    expect(withDefaultModel(agent).model).toBe("claude-sonnet-5-5");
  });

  it("uses the score's default_model over the CLI default", () => {
    expect(withDefaultModel(agent, "claude-opus-4-7").model).toBe("claude-opus-4-7");
  });

  it("keeps a model the agent names, even the retired id", () => {
    const pinned: AgentConfig = { ...agent, model: "claude-sonnet-4-20250514" };
    const result = withDefaultModel(pinned, "claude-opus-4-7");
    expect(result).toBe(pinned);
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("treats an empty default_model as set and does not mutate the agent", () => {
    const result = withDefaultModel(agent, "");
    expect(result.model).toBe("");
    expect(result).not.toBe(agent);
    expect(agent.model).toBeUndefined();
  });
});
