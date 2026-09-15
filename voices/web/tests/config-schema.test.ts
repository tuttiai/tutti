import { describe, it, expect } from "vitest";
import { WebVoiceConfigSchema } from "../src/index.js";

describe("WebVoiceConfigSchema", () => {
  it("accepts a full configuration", () => {
    const config = {
      provider: "brave" as const,
      cache: true,
      max_results: 5,
      rate_limit: { per_minute: 30 },
      timeout_ms: 5_000,
    };
    expect(WebVoiceConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts an empty configuration, which auto-selects a provider", () => {
    expect(WebVoiceConfigSchema.parse({})).toEqual({});
  });

  it.each(["brave", "serper", "duckduckgo"])("accepts the %s provider", (provider) => {
    expect(WebVoiceConfigSchema.parse({ provider }).provider).toBe(provider);
  });

  it("rejects a provider that is not one of the three named ones", () => {
    expect(() => WebVoiceConfigSchema.parse({ provider: "google" })).toThrow();
  });

  it("rejects max_results above the documented ceiling of 20", () => {
    expect(() => WebVoiceConfigSchema.parse({ max_results: 21 })).toThrow();
  });

  it("rejects a rate limit carrying an unknown key", () => {
    expect(() => WebVoiceConfigSchema.parse({ rate_limit: { per_hour: 100 } })).toThrow();
  });
});
