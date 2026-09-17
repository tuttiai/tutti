import { describe, it, expect } from "vitest";
import { GitHubVoiceConfigSchema } from "../src/index.js";

describe("GitHubVoiceConfigSchema", () => {
  it("accepts a configuration carrying only token", () => {
    expect(GitHubVoiceConfigSchema.parse({ token: "ghp_example" })).toEqual({ token: "ghp_example" });
  });

  it("accepts an empty configuration, because token falls back to the environment", () => {
    expect(GitHubVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty token rather than treating it as absent", () => {
    expect(() => GitHubVoiceConfigSchema.parse({ token: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => GitHubVoiceConfigSchema.parse({ tokens: "ghp_example" })).toThrow();
  });
});
