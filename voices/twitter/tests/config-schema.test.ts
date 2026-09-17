import { describe, it, expect } from "vitest";
import { TwitterVoiceConfigSchema } from "../src/index.js";

const WRITE_CREDS = {
  api_key: "k",
  api_secret: "s",
  access_token: "t",
  access_token_secret: "ts",
};

describe("TwitterVoiceConfigSchema", () => {
  it("accepts read-only credentials", () => {
    expect(TwitterVoiceConfigSchema.parse({ bearer_token: "b" })).toEqual({ bearer_token: "b" });
  });

  it("accepts all four write credentials together", () => {
    expect(TwitterVoiceConfigSchema.parse(WRITE_CREDS)).toEqual(WRITE_CREDS);
  });

  it("accepts none of the write credentials", () => {
    expect(TwitterVoiceConfigSchema.parse({})).toEqual({});
  });

  it.each(Object.keys(WRITE_CREDS))("rejects a partial write credential set missing %s", (omitted) => {
    const partial = { ...WRITE_CREDS };
    delete partial[omitted as keyof typeof WRITE_CREDS];
    expect(() => TwitterVoiceConfigSchema.parse(partial)).toThrow(/all four/);
  });

  it("rejects an unknown key", () => {
    expect(() => TwitterVoiceConfigSchema.parse({ bearerToken: "b" })).toThrow();
  });
});
