import { describe, it, expect } from "vitest";
import { TokenBucketRateLimit, DEFAULT_RATE_LIMIT } from "../src/rate-limit.js";

describe("TokenBucketRateLimit", () => {
  it("allows up to `burst` requests immediately, then blocks", () => {
    const rl = new TokenBucketRateLimit({ messagesPerWindow: 30, windowMs: 60_000, burst: 3 });
    const now = 1_000_000_000;
    expect(rl.allow("user", now)).toBe(true);
    expect(rl.allow("user", now)).toBe(true);
    expect(rl.allow("user", now)).toBe(true);
    expect(rl.allow("user", now)).toBe(false);
  });

  it("refills tokens at the configured rate", () => {
    // 60 / 60_000 = 1 token per 1000 ms
    const rl = new TokenBucketRateLimit({ messagesPerWindow: 60, windowMs: 60_000, burst: 2 });
    const t0 = 1_000_000_000;
    expect(rl.allow("u", t0)).toBe(true);
    expect(rl.allow("u", t0)).toBe(true);
    expect(rl.allow("u", t0)).toBe(false);
    // After 1000ms, exactly one token should be available.
    expect(rl.allow("u", t0 + 1_000)).toBe(true);
    expect(rl.allow("u", t0 + 1_000)).toBe(false);
  });

  it("clamps refill at capacity", () => {
    const rl = new TokenBucketRateLimit({ messagesPerWindow: 60, windowMs: 60_000, burst: 2 });
    const t0 = 1_000_000_000;
    rl.allow("u", t0);
    // A long idle period should not exceed capacity.
    expect(rl.allow("u", t0 + 60 * 60_000)).toBe(true);
    expect(rl.allow("u", t0 + 60 * 60_000)).toBe(true);
    expect(rl.allow("u", t0 + 60 * 60_000)).toBe(false);
  });

  it("buckets are per-key — independent budgets", () => {
    const rl = new TokenBucketRateLimit({ messagesPerWindow: 30, windowMs: 60_000, burst: 1 });
    const now = 1_000_000_000;
    expect(rl.allow("a", now)).toBe(true);
    expect(rl.allow("b", now)).toBe(true);
    expect(rl.allow("a", now)).toBe(false);
    expect(rl.allow("b", now)).toBe(false);
  });

  it("`disabled: true` lets every request through and never grows", () => {
    const rl = new TokenBucketRateLimit({ disabled: true });
    for (let i = 0; i < 1_000; i++) {
      expect(rl.allow("u")).toBe(true);
    }
    expect(rl._size).toBe(0);
  });

  it("default config is reasonable: 30/60s burst 10", () => {
    const rl = new TokenBucketRateLimit(DEFAULT_RATE_LIMIT);
    const now = 1_000_000_000;
    for (let i = 0; i < 10; i++) {
      expect(rl.allow("u", now)).toBe(true);
    }
    expect(rl.allow("u", now)).toBe(false);
  });

  it("gc evicts buckets idle past 2 windows", () => {
    const rl = new TokenBucketRateLimit({ messagesPerWindow: 30, windowMs: 1_000, burst: 1 });
    const t0 = 1_000_000_000;
    rl.allow("u", t0);
    expect(rl._size).toBe(1);
    rl.gc(t0 + 100);
    expect(rl._size).toBe(1);
    rl.gc(t0 + 5_000);
    expect(rl._size).toBe(0);
  });

  it("rejects non-positive config", () => {
    expect(() => new TokenBucketRateLimit({ messagesPerWindow: 0, windowMs: 1_000 })).toThrow(
      RangeError,
    );
    expect(() => new TokenBucketRateLimit({ messagesPerWindow: 30, windowMs: -1 })).toThrow(
      RangeError,
    );
  });
});
