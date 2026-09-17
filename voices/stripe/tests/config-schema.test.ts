import { describe, it, expect } from "vitest";
import { StripeVoiceConfigSchema } from "../src/index.js";

describe("StripeVoiceConfigSchema", () => {
  it("accepts a configuration carrying only api_key", () => {
    expect(StripeVoiceConfigSchema.parse({ api_key: "sk_test_example" })).toEqual({ api_key: "sk_test_example" });
  });

  it("accepts an empty configuration, because api_key falls back to the environment", () => {
    expect(StripeVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty api_key rather than treating it as absent", () => {
    expect(() => StripeVoiceConfigSchema.parse({ api_key: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => StripeVoiceConfigSchema.parse({ api_keys: "sk_test_example" })).toThrow();
  });
});
