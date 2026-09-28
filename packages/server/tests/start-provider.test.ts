import { describe, it, expect } from "vitest";
import { AnthropicProvider, ClaudeCodeProvider } from "@tuttiai/core";

import { buildStartProvider } from "../src/start-provider.js";

describe("buildStartProvider", () => {
  it("defaults to Anthropic when TUTTI_PROVIDER is unset", () => {
    expect(buildStartProvider(undefined)).toBeInstanceOf(AnthropicProvider);
  });

  it("builds the Claude Code provider for claude-code", () => {
    expect(buildStartProvider("claude-code")).toBeInstanceOf(ClaudeCodeProvider);
  });

  it("refuses an unknown name and lists the accepted ones", () => {
    expect(() => buildStartProvider("bedrock")).toThrow(/anthropic, openai, gemini, claude-code/);
  });
});
