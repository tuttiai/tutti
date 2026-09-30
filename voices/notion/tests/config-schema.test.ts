import { describe, it, expect } from "vitest";

import { NotionVoiceConfigSchema } from "../src/index.js";

describe("NotionVoiceConfigSchema", () => {
  it("accepts a configuration carrying only token", () => {
    expect(NotionVoiceConfigSchema.parse({ token: "ntn_example" })).toEqual({ token: "ntn_example" });
  });

  it("accepts an empty configuration, because token falls back to the environment", () => {
    expect(NotionVoiceConfigSchema.parse({})).toEqual({});
  });

  it("rejects an empty token rather than treating it as absent", () => {
    expect(() => NotionVoiceConfigSchema.parse({ token: "" })).toThrow();
  });

  it("rejects an unknown key, so a typo in a stored document fails loudly", () => {
    expect(() => NotionVoiceConfigSchema.parse({ api_key: "ntn_example" })).toThrow();
  });
});
