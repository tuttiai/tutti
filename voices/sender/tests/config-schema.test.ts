import { describe, it, expect } from "vitest";
import { SenderVoiceConfigSchema } from "../src/index.js";

describe("SenderVoiceConfigSchema", () => {
  it("accepts a configuration carrying only api_key", () => {
    expect(SenderVoiceConfigSchema.parse({ api_key: "tok_example" })).toEqual({ api_key: "tok_example" });
  });

  it("accepts an empty configuration, because api_key falls back to the environment", () => {
    expect(SenderVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty api_key rather than treating it as absent", () => {
    expect(() => SenderVoiceConfigSchema.parse({ api_key: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => SenderVoiceConfigSchema.parse({ api_keys: "tok_example" })).toThrow();
  });
});
