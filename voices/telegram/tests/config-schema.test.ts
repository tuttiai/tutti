import { describe, it, expect } from "vitest";
import { TelegramVoiceConfigSchema } from "../src/index.js";

describe("TelegramVoiceConfigSchema", () => {
  it("accepts a configuration carrying only token", () => {
    expect(TelegramVoiceConfigSchema.parse({ token: "telegram-example" })).toEqual({ token: "telegram-example" });
  });

  it("accepts an empty configuration, because token falls back to the environment", () => {
    expect(TelegramVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty token rather than treating it as absent", () => {
    expect(() => TelegramVoiceConfigSchema.parse({ token: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => TelegramVoiceConfigSchema.parse({ tokens: "telegram-example" })).toThrow();
  });
});
