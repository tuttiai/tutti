import { describe, it, expect } from "vitest";
import { WhatsAppVoiceConfigSchema } from "../src/index.js";

describe("WhatsAppVoiceConfigSchema", () => {
  it("accepts a minimal configuration", () => {
    expect(WhatsAppVoiceConfigSchema.parse({ phoneNumberId: "123" })).toEqual({
      phoneNumberId: "123",
    });
  });

  it("requires phoneNumberId", () => {
    expect(() => WhatsAppVoiceConfigSchema.parse({})).toThrow();
  });

  it("accepts a rate limit object", () => {
    const parsed = WhatsAppVoiceConfigSchema.parse({
      phoneNumberId: "123",
      rateLimit: { max: 100, windowMs: 60_000 },
    });
    expect(parsed.rateLimit).toEqual({ max: 100, windowMs: 60_000 });
  });

  it("accepts rateLimit false, which disables the webhook rate limit", () => {
    const parsed = WhatsAppVoiceConfigSchema.parse({ phoneNumberId: "123", rateLimit: false });
    expect(parsed.rateLimit).toBe(false);
  });

  it("rejects rateLimit true, because only false is a meaningful boolean here", () => {
    expect(() =>
      WhatsAppVoiceConfigSchema.parse({ phoneNumberId: "123", rateLimit: true }),
    ).toThrow();
  });

  it("rejects fetchFn, which is a test seam and not serialisable", () => {
    expect(() =>
      WhatsAppVoiceConfigSchema.parse({ phoneNumberId: "123", fetchFn: "x" }),
    ).toThrow();
  });
});
