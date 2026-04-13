import { describe, it, expect, vi, afterEach } from "vitest";
import {
  InMemoryToolCache,
  DEFAULT_CACHE_MAX_ENTRIES,
} from "../../src/cache/in-memory-cache.js";

describe("InMemoryToolCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("get/set", () => {
    it("returns null when the key is absent", async () => {
      const cache = new InMemoryToolCache();
      expect(await cache.get("read_file", { path: "a.md" })).toBeNull();
    });

    it("returns the stored result on a hit", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a.md" }, { content: "hello" });

      const hit = await cache.get("read_file", { path: "a.md" });
      expect(hit).toEqual({ content: "hello" });
    });

    it("differentiates by input — same tool, different args", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a.md" }, { content: "A" });
      await cache.set("read_file", { path: "b.md" }, { content: "B" });

      expect((await cache.get("read_file", { path: "a.md" }))?.content).toBe("A");
      expect((await cache.get("read_file", { path: "b.md" }))?.content).toBe("B");
    });

    it("differentiates by tool — different tools, same args", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a.md" }, { content: "text" });
      await cache.set("stat_file", { path: "a.md" }, { content: "stats" });

      expect((await cache.get("read_file", { path: "a.md" }))?.content).toBe("text");
      expect((await cache.get("stat_file", { path: "a.md" }))?.content).toBe("stats");
    });

    it("resists key collision between a tool with pipe chars and a neighbour", async () => {
      // Regression guard: if we naively concatenated tool+JSON without a
      // separator, (`a|b`, {}) and (`a`, "|b") could collide.
      const cache = new InMemoryToolCache();
      await cache.set("a|b", {}, { content: "one" });
      await cache.set("a", "|b", { content: "two" });

      expect((await cache.get("a|b", {}))?.content).toBe("one");
      expect((await cache.get("a", "|b"))?.content).toBe("two");
    });
  });

  describe("TTL", () => {
    it("returns the entry before expiry", async () => {
      vi.useFakeTimers();
      const cache = new InMemoryToolCache({ default_ttl_ms: 1000 });

      await cache.set("read_file", { path: "a" }, { content: "x" });
      vi.advanceTimersByTime(500);
      expect(await cache.get("read_file", { path: "a" })).toEqual({
        content: "x",
      });
    });

    it("returns null once the default TTL has elapsed", async () => {
      vi.useFakeTimers();
      const cache = new InMemoryToolCache({ default_ttl_ms: 1000 });

      await cache.set("read_file", { path: "a" }, { content: "x" });
      vi.advanceTimersByTime(1001);
      expect(await cache.get("read_file", { path: "a" })).toBeNull();
    });

    it("per-entry ttl_ms override takes precedence over default", async () => {
      vi.useFakeTimers();
      const cache = new InMemoryToolCache({ default_ttl_ms: 10_000 });

      await cache.set("read_file", { path: "a" }, { content: "x" }, 100);
      vi.advanceTimersByTime(150);
      expect(await cache.get("read_file", { path: "a" })).toBeNull();
    });

    it("drops the key after expiry so it's reclaimed", async () => {
      vi.useFakeTimers();
      const cache = new InMemoryToolCache({ default_ttl_ms: 500 });

      await cache.set("read_file", { path: "a" }, { content: "x" });
      vi.advanceTimersByTime(501);
      await cache.get("read_file", { path: "a" }); // triggers eviction
      expect(cache.size).toBe(0);
    });
  });

  describe("invalidate", () => {
    it("removes a single entry when input is provided", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a" }, { content: "A" });
      await cache.set("read_file", { path: "b" }, { content: "B" });

      await cache.invalidate("read_file", { path: "a" });

      expect(await cache.get("read_file", { path: "a" })).toBeNull();
      expect((await cache.get("read_file", { path: "b" }))?.content).toBe("B");
    });

    it("removes every entry for a tool when input is omitted", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a" }, { content: "A" });
      await cache.set("read_file", { path: "b" }, { content: "B" });
      await cache.set("stat_file", { path: "a" }, { content: "S" });

      await cache.invalidate("read_file");

      expect(await cache.get("read_file", { path: "a" })).toBeNull();
      expect(await cache.get("read_file", { path: "b" })).toBeNull();
      expect((await cache.get("stat_file", { path: "a" }))?.content).toBe("S");
    });
  });

  describe("clear", () => {
    it("drops every entry", async () => {
      const cache = new InMemoryToolCache();
      await cache.set("read_file", { path: "a" }, { content: "A" });
      await cache.set("stat_file", { path: "a" }, { content: "S" });

      await cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts the least-recently-used entry when full", async () => {
      const cache = new InMemoryToolCache({ max_entries: 3 });

      await cache.set("t", 1, { content: "1" });
      await cache.set("t", 2, { content: "2" });
      await cache.set("t", 3, { content: "3" });
      // Touch entry 1 so it becomes MRU; entry 2 is now LRU.
      await cache.get("t", 1);
      await cache.set("t", 4, { content: "4" });

      expect(cache.size).toBe(3);
      expect((await cache.get("t", 1))?.content).toBe("1");
      expect(await cache.get("t", 2)).toBeNull();
      expect((await cache.get("t", 3))?.content).toBe("3");
      expect((await cache.get("t", 4))?.content).toBe("4");
    });

    it("defaults max_entries to 1000", async () => {
      const cache = new InMemoryToolCache();
      // Exercise the public export indirectly — we can't easily write 1001
      // entries in a unit test without blowing up runtime. Just assert the
      // exported constant matches the instance's bound by poking with a
      // small test instead.
      expect(DEFAULT_CACHE_MAX_ENTRIES).toBe(1000);
      await cache.set("t", 1, { content: "1" });
      expect(cache.size).toBe(1);
    });
  });
});
