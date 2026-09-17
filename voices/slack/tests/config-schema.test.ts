import { describe, it, expect } from "vitest";
import { SlackVoiceConfigSchema } from "../src/index.js";

describe("SlackVoiceConfigSchema", () => {
  it("accepts a configuration carrying only token", () => {
    expect(SlackVoiceConfigSchema.parse({ token: "xoxb-example" })).toEqual({ token: "xoxb-example" });
  });

  it("accepts an empty configuration, because token falls back to the environment", () => {
    expect(SlackVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty token rather than treating it as absent", () => {
    expect(() => SlackVoiceConfigSchema.parse({ token: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => SlackVoiceConfigSchema.parse({ tokens: "xoxb-example" })).toThrow();
  });
});
