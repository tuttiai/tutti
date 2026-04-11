import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SecretsManager } from "../src/secrets.js";

describe("SecretsManager", () => {
  describe("redact()", () => {
    it("redacts Anthropic API keys", () => {
      const text = "key is sk-ant-api03-abcdefghijklmnopqrst1234567890";
      expect(SecretsManager.redact(text)).toBe("key is [REDACTED]");
    });

    it("redacts OpenAI API keys", () => {
      const text = "key is sk-proj1234567890abcdefghij";
      expect(SecretsManager.redact(text)).toBe("key is [REDACTED]");
    });

    it("redacts GitHub personal access tokens", () => {
      const text = "token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      expect(SecretsManager.redact(text)).toBe("token is [REDACTED]");
    });

    it("redacts Google API keys", () => {
      const text = "key is AIzaSyB1234567890abcdefghijklmnopqrstuv";
      expect(SecretsManager.redact(text)).toBe("key is [REDACTED]");
    });

    it("redacts Bearer tokens", () => {
      const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
      expect(SecretsManager.redact(text)).toBe("Authorization: [REDACTED]");
    });

    it("redacts multiple secrets in the same string", () => {
      const text =
        "anthropic=sk-ant-api03-abcdefghijklmnopqrst1234567890 " +
        "openai=sk-proj1234567890abcdefghij";
      const redacted = SecretsManager.redact(text);
      expect(redacted).toBe("anthropic=[REDACTED] openai=[REDACTED]");
    });

    it("passes normal text through unchanged", () => {
      const text = "Hello world, this is a normal message with no secrets.";
      expect(SecretsManager.redact(text)).toBe(text);
    });

    it("passes short strings that look like prefixes but are too short", () => {
      const text = "sk-short";
      expect(SecretsManager.redact(text)).toBe(text);
    });
  });

  describe("redactObject()", () => {
    it("redacts secrets nested inside objects", () => {
      const obj = {
        config: {
          api_key: "sk-ant-api03-abcdefghijklmnopqrst1234567890",
        },
        message: "hello",
      };
      const result = SecretsManager.redactObject(obj) as typeof obj;
      expect(result.config.api_key).toBe("[REDACTED]");
      expect(result.message).toBe("hello");
    });

    it("redacts secrets in arrays", () => {
      const arr = ["sk-proj1234567890abcdefghij", "normal"];
      const result = SecretsManager.redactObject(arr) as string[];
      expect(result[0]).toBe("[REDACTED]");
      expect(result[1]).toBe("normal");
    });
  });

  describe("require()", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns the env var value when set", () => {
      process.env.TEST_SECRET = "my-secret";
      expect(SecretsManager.require("TEST_SECRET")).toBe("my-secret");
    });

    it("throws with a helpful message when env var is missing", () => {
      delete process.env.TEST_SECRET;
      expect(() => SecretsManager.require("TEST_SECRET")).toThrow(
        "Missing required env var: TEST_SECRET",
      );
      expect(() => SecretsManager.require("TEST_SECRET")).toThrow(
        "Add it to your .env file: TEST_SECRET=your_value_here",
      );
    });
  });

  describe("optional()", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns the env var value when set", () => {
      process.env.OPT_KEY = "value";
      expect(SecretsManager.optional("OPT_KEY")).toBe("value");
    });

    it("returns undefined when env var is missing and no fallback", () => {
      delete process.env.OPT_KEY;
      expect(SecretsManager.optional("OPT_KEY")).toBeUndefined();
    });

    it("returns fallback when env var is missing", () => {
      delete process.env.OPT_KEY;
      expect(SecretsManager.optional("OPT_KEY", "default")).toBe("default");
    });
  });
});
