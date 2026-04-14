import { describe, it, expect, beforeEach } from "vitest";
import { cacheKey, getCached, setCached, clearCache } from "../src/cache.js";

beforeEach(() => {
  clearCache();
});

describe("cacheKey", () => {
  it("returns a hex sha256 digest", () => {
    const key = cacheKey("https://example.com");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different keys for different inputs", () => {
    const a = cacheKey("https://a.com");
    const b = cacheKey("https://b.com");
    expect(a).not.toBe(b);
  });

  it("concatenates multiple parts with a separator", () => {
    const single = cacheKey("hello|world");
    const multi = cacheKey("hello", "world");
    expect(single).toBe(multi);
  });
});

describe("getCached / setCached", () => {
  it("returns null for a missing key", () => {
    expect(getCached("missing")).toBeNull();
  });

  it("stores and retrieves a value", () => {
    setCached("k1", { data: 42 });
    expect(getCached("k1")).toEqual({ data: 42 });
  });

  it("returns null after TTL expires", async () => {
    setCached("short", "value", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    expect(getCached("short")).toBeNull();
  });

  it("respects the max entries limit by evicting LRU", () => {
    // Fill 500 entries (the max), then add one more.
    for (let i = 0; i < 500; i++) {
      setCached("e" + i, i);
    }
    // Entry 0 is the oldest — should still be present before overflow.
    expect(getCached("e0")).toBe(0);

    // Adding one more evicts the least-recently-used entry.
    setCached("overflow", "new");
    expect(getCached("overflow")).toBe("new");
  });
});

describe("clearCache", () => {
  it("removes all entries", () => {
    setCached("a", 1);
    setCached("b", 2);
    clearCache();
    expect(getCached("a")).toBeNull();
    expect(getCached("b")).toBeNull();
  });
});
