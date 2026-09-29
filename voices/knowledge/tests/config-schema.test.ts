import { describe, it, expect } from "vitest";

import { KnowledgeVoiceConfigSchema } from "../src/index.js";

const MINIMAL = { url: "http://control-plane:4849/agent/v1/knowledge", token: "k" };

describe("KnowledgeVoiceConfigSchema", () => {
  it("accepts an http address and a token", () => {
    expect(KnowledgeVoiceConfigSchema.parse(MINIMAL)).toEqual(MINIMAL);
  });

  it("accepts a private address, because the deployer chose it and no tool takes one", () => {
    expect(KnowledgeVoiceConfigSchema.parse({ ...MINIMAL, url: "http://10.0.0.4:4849/k" }).url).toBe("http://10.0.0.4:4849/k");
  });

  it("refuses a scheme that is not http or https", () => {
    expect(() => KnowledgeVoiceConfigSchema.parse({ ...MINIMAL, url: "file:///etc/passwd" })).toThrow(/http or https/);
  });

  it("refuses an empty token", () => {
    expect(() => KnowledgeVoiceConfigSchema.parse({ ...MINIMAL, token: "" })).toThrow();
  });

  it.each([0, 21])("refuses a default_top_k of %i", (value) => {
    expect(() => KnowledgeVoiceConfigSchema.parse({ ...MINIMAL, default_top_k: value })).toThrow();
  });

  it("refuses an unknown key", () => {
    expect(() => KnowledgeVoiceConfigSchema.parse({ ...MINIMAL, bases: ["docs"] })).toThrow();
  });
});
