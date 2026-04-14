import { describe, it, expect } from "vitest";
import { piiDetector } from "../../src/guardrails/pii-detector.js";
import { GuardrailError } from "../../src/errors.js";

const ctx = { agent_name: "test", session_id: "s1" };

describe("piiDetector — redact mode", () => {
  const guard = piiDetector("redact");

  it("redacts email addresses", async () => {
    const result = await guard("Contact alice@example.com for info", ctx);
    expect(result).toBe("Contact [PII] for info");
  });

  it("redacts phone numbers", async () => {
    const result = await guard("Call me at (555) 123-4567 please", ctx);
    expect(result).toBe("Call me at [PII] please");
  });

  it("redacts SSNs", async () => {
    const result = await guard("My SSN is 123-45-6789", ctx);
    expect(result).toBe("My SSN is [PII]");
  });

  it("redacts credit card numbers", async () => {
    const result = await guard("Card: 4111-1111-1111-1111", ctx);
    expect(result).toBe("Card: [PII]");
  });

  it("redacts credit card numbers without separators", async () => {
    const result = await guard("Card: 4111111111111111", ctx);
    expect(result).toBe("Card: [PII]");
  });

  it("redacts multiple PII types in one string", async () => {
    const result = await guard(
      "Email: test@foo.com, SSN: 111-22-3333",
      ctx,
    );
    expect(result).toBe("Email: [PII], SSN: [PII]");
  });

  it("returns clean text unchanged", async () => {
    const input = "No personal data here.";
    const result = await guard(input, ctx);
    expect(result).toBe(input);
  });
});

describe("piiDetector — block mode", () => {
  const guard = piiDetector("block");

  it("throws GuardrailError on email detection", async () => {
    await expect(
      guard("Contact alice@example.com", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("throws GuardrailError on phone detection", async () => {
    await expect(
      guard("Call 555-123-4567", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("throws GuardrailError on SSN detection", async () => {
    await expect(
      guard("SSN: 123-45-6789", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("throws GuardrailError on credit card detection", async () => {
    await expect(
      guard("Card: 4111 1111 1111 1111", ctx),
    ).rejects.toThrow(GuardrailError);
  });

  it("includes PII type in error context", async () => {
    try {
      await guard("My email is me@x.co", ctx);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailError);
      expect((err as GuardrailError).context).toHaveProperty("pii_type", "email");
    }
  });

  it("passes clean text through", async () => {
    const input = "Nothing sensitive here.";
    const result = await guard(input, ctx);
    expect(result).toBe(input);
  });
});
