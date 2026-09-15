import { describe, it, expect } from "vitest";
import { DiscordVoiceConfigSchema } from "../src/index.js";

describe("DiscordVoiceConfigSchema", () => {
  it("accepts a configuration carrying only token", () => {
    expect(DiscordVoiceConfigSchema.parse({ token: "discord-example" })).toEqual({ token: "discord-example" });
  });

  it("accepts an empty configuration, because token falls back to the environment", () => {
    expect(DiscordVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty token rather than treating it as absent", () => {
    expect(() => DiscordVoiceConfigSchema.parse({ token: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => DiscordVoiceConfigSchema.parse({ tokens: "discord-example" })).toThrow();
  });
});
