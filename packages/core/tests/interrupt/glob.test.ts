import { describe, it, expect } from "vitest";
import {
  globMatch,
  matchesAny,
  needsApproval,
} from "../../src/interrupt/index.js";

describe("globMatch", () => {
  it("matches exact strings when no wildcard is present", () => {
    expect(globMatch("send_email", "send_email")).toBe(true);
    expect(globMatch("send_email", "send_sms")).toBe(false);
    expect(globMatch("send_email", "SEND_EMAIL")).toBe(false); // case-sensitive
  });

  it("treats '*' as 'any sequence' (possibly empty)", () => {
    expect(globMatch("send_*", "send_email")).toBe(true);
    expect(globMatch("send_*", "send_sms")).toBe(true);
    expect(globMatch("send_*", "send_")).toBe(true); // empty suffix
    expect(globMatch("send_*", "resend_email")).toBe(false); // wrong prefix
    expect(globMatch("send_*", "send")).toBe(false); // no underscore
  });

  it("supports wildcards at any position", () => {
    expect(globMatch("*_admin", "delete_admin")).toBe(true);
    expect(globMatch("*_admin", "admin")).toBe(false); // no underscore
    expect(globMatch("payment_*", "payment_capture")).toBe(true);
    expect(globMatch("user_*_write", "user_profile_write")).toBe(true);
    expect(globMatch("user_*_write", "user_profile_read")).toBe(false);
  });

  it("supports multiple wildcards in one pattern", () => {
    expect(globMatch("*_*", "send_email")).toBe(true);
    expect(globMatch("*_*", "solo")).toBe(false);
  });

  it("does NOT treat other glob-ish chars specially (regex escaping)", () => {
    // These should all be literal — regex metachars are escaped.
    expect(globMatch("tool.name", "tool.name")).toBe(true);
    expect(globMatch("tool.name", "toolXname")).toBe(false); // '.' is literal
    expect(globMatch("tool+name", "tool+name")).toBe(true);
    expect(globMatch("(paren)", "(paren)")).toBe(true);
    expect(globMatch("a[b]c", "a[b]c")).toBe(true);
    // '?' isn't a glob wildcard in our helper — it matches only '?'.
    expect(globMatch("tool?", "tools")).toBe(false);
    expect(globMatch("tool?", "tool?")).toBe(true);
  });
});

describe("matchesAny", () => {
  it("returns true when any pattern matches", () => {
    expect(matchesAny(["send_*", "delete_*"], "delete_user")).toBe(true);
    expect(matchesAny(["send_*", "delete_*"], "send_email")).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesAny(["send_*", "delete_*"], "read_file")).toBe(false);
  });

  it("returns false for an empty pattern list", () => {
    expect(matchesAny([], "anything")).toBe(false);
  });
});

describe("needsApproval", () => {
  it("returns false when config is undefined or false", () => {
    expect(needsApproval(undefined, "send_email")).toBe(false);
    expect(needsApproval(false, "send_email")).toBe(false);
  });

  it("returns true for every tool when config is 'all'", () => {
    expect(needsApproval("all", "send_email")).toBe(true);
    expect(needsApproval("all", "read_file")).toBe(true);
    expect(needsApproval("all", "")).toBe(true); // even edge names
  });

  it("returns true only for matching patterns when config is string[]", () => {
    const patterns = ["send_*", "delete_*", "payment_*"];
    expect(needsApproval(patterns, "send_email")).toBe(true);
    expect(needsApproval(patterns, "delete_user")).toBe(true);
    expect(needsApproval(patterns, "payment_capture")).toBe(true);
    expect(needsApproval(patterns, "read_file")).toBe(false);
    expect(needsApproval(patterns, "list_users")).toBe(false);
  });

  it("short-circuits on the first matching pattern", () => {
    // Correctness check — ensure order doesn't affect the outcome.
    expect(needsApproval(["read_*", "send_*"], "send_email")).toBe(true);
    expect(needsApproval(["send_*", "read_*"], "send_email")).toBe(true);
  });

  it("returns false for an empty pattern array", () => {
    expect(needsApproval([], "anything")).toBe(false);
  });
});
