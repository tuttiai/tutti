import { describe, it, expect } from "vitest";
import { EmailVoiceConfigSchema } from "../src/index.js";

const VALID = {
  imap: { host: "imap.example.com", port: 993, user: "bot", secure: true },
  smtp: { host: "smtp.example.com", port: 587, user: "bot", secure: false },
  from: "Tutti Bot <bot@example.com>",
};

describe("EmailVoiceConfigSchema", () => {
  it("accepts a valid configuration", () => {
    expect(EmailVoiceConfigSchema.parse(VALID)).toEqual(VALID);
  });

  it("accepts passwords omitted, because both fall back to the environment", () => {
    expect(EmailVoiceConfigSchema.parse(VALID).imap.password).toBeUndefined();
  });

  it("requires from, because outbound mail has no default sender", () => {
    const { from: _from, ...rest } = VALID;
    expect(() => EmailVoiceConfigSchema.parse(rest)).toThrow();
  });

  it("requires both endpoints", () => {
    const { smtp: _smtp, ...rest } = VALID;
    expect(() => EmailVoiceConfigSchema.parse(rest)).toThrow();
  });

  it("rejects a port outside the valid range", () => {
    const bad = { ...VALID, imap: { ...VALID.imap, port: 70_000 } };
    expect(() => EmailVoiceConfigSchema.parse(bad)).toThrow();
  });

  it("rejects _imapFactory, which is a test seam and not serialisable", () => {
    expect(() => EmailVoiceConfigSchema.parse({ ...VALID, _imapFactory: "x" })).toThrow();
  });
});
