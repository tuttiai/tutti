import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_MAX_MEMORIES_PER_USER,
  MemoryUserMemoryStore,
} from "../../../src/memory/user/memory-store.js";

const USER_A = "user-a";
const USER_B = "user-b";

describe("MemoryUserMemoryStore — store", () => {
  let store: MemoryUserMemoryStore;
  beforeEach(() => {
    store = new MemoryUserMemoryStore();
  });

  it("returns a memory with generated id, created_at, and option defaults", async () => {
    const m = await store.store(USER_A, "User prefers TypeScript");
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.user_id).toBe(USER_A);
    expect(m.content).toBe("User prefers TypeScript");
    expect(m.source).toBe("explicit"); // default
    expect(m.importance).toBe(2); // default
    expect(m.tags).toBeUndefined();
    expect(m.expires_at).toBeUndefined();
    expect(m.created_at).toBeInstanceOf(Date);
  });

  it("respects every StoreOptions field when provided", async () => {
    const expires = new Date("2030-01-01T00:00:00Z");
    const m = await store.store(USER_A, "Prefers French", {
      source: "inferred",
      importance: 3,
      tags: ["language", "preferences"],
      expires_at: expires,
    });
    expect(m.source).toBe("inferred");
    expect(m.importance).toBe(3);
    expect(m.tags).toEqual(["language", "preferences"]);
    expect(m.expires_at).toBe(expires);
  });

  it("isolates memories by user_id", async () => {
    await store.store(USER_A, "A's memory");
    await store.store(USER_B, "B's memory");
    expect(await store.list(USER_A)).toHaveLength(1);
    expect(await store.list(USER_B)).toHaveLength(1);
    expect((await store.list(USER_A))[0]!.content).toBe("A's memory");
  });
});

describe("MemoryUserMemoryStore — search", () => {
  let store: MemoryUserMemoryStore;
  beforeEach(() => {
    store = new MemoryUserMemoryStore();
  });

  it("finds memories by case-insensitive substring match", async () => {
    await store.store(USER_A, "User prefers TypeScript over JavaScript");
    await store.store(USER_A, "Lives in Berlin");
    await store.store(USER_A, "Loves coffee");

    const hits = await store.search(USER_A, "typescript");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("TypeScript");
  });

  it("returns nothing for an empty / whitespace query", async () => {
    await store.store(USER_A, "anything");
    expect(await store.search(USER_A, "")).toEqual([]);
    expect(await store.search(USER_A, "   ")).toEqual([]);
  });

  it("ranks by importance DESC then created_at DESC", async () => {
    await store.store(USER_A, "low priority alpha", { importance: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "low priority beta", { importance: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "high priority gamma", { importance: 3 });

    const hits = await store.search(USER_A, "priority");
    expect(hits.map((h) => h.content)).toEqual([
      "high priority gamma", // importance 3 wins
      "low priority beta", // newer of the two importance-1 memories
      "low priority alpha",
    ]);
  });

  it("respects the limit argument", async () => {
    for (let i = 0; i < 5; i++) {
      await store.store(USER_A, "match-" + i);
    }
    expect(await store.search(USER_A, "match", 2)).toHaveLength(2);
    expect(await store.search(USER_A, "match", 100)).toHaveLength(5);
  });

  it("isolates results by user_id", async () => {
    await store.store(USER_A, "shared keyword");
    await store.store(USER_B, "shared keyword");
    const hitsA = await store.search(USER_A, "keyword");
    expect(hitsA).toHaveLength(1);
    expect(hitsA[0]!.user_id).toBe(USER_A);
  });

  it("bumps last_accessed_at on every returned row", async () => {
    const m = await store.store(USER_A, "hello world");
    expect(m.last_accessed_at).toBeUndefined();

    const before = Date.now();
    const hits = await store.search(USER_A, "hello");
    const after = Date.now();

    expect(hits[0]!.last_accessed_at).toBeInstanceOf(Date);
    const ts = hits[0]!.last_accessed_at!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("excludes expired memories", async () => {
    await store.store(USER_A, "stale thought", {
      expires_at: new Date(Date.now() - 1000),
    });
    await store.store(USER_A, "fresh thought");
    const hits = await store.search(USER_A, "thought");
    expect(hits.map((h) => h.content)).toEqual(["fresh thought"]);
  });
});

describe("MemoryUserMemoryStore — list", () => {
  let store: MemoryUserMemoryStore;
  beforeEach(() => {
    store = new MemoryUserMemoryStore();
  });

  it("returns every memory for a user, most-recently-created first", async () => {
    await store.store(USER_A, "first");
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "second");
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "third");
    const all = await store.list(USER_A);
    expect(all.map((m) => m.content)).toEqual(["third", "second", "first"]);
  });

  it("returns an empty array for an unknown user", async () => {
    expect(await store.list("never-stored")).toEqual([]);
  });

  it("filters out expired memories", async () => {
    await store.store(USER_A, "alive");
    await store.store(USER_A, "stale", {
      expires_at: new Date(Date.now() - 1000),
    });
    expect((await store.list(USER_A)).map((m) => m.content)).toEqual(["alive"]);
  });
});

describe("MemoryUserMemoryStore — delete / deleteAll / get", () => {
  let store: MemoryUserMemoryStore;
  beforeEach(() => {
    store = new MemoryUserMemoryStore();
  });

  it("delete removes a memory by id", async () => {
    const m = await store.store(USER_A, "doomed");
    await store.delete(m.id);
    expect(await store.list(USER_A)).toEqual([]);
  });

  it("delete is idempotent on unknown ids", async () => {
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("deleteAll removes every memory for a user", async () => {
    await store.store(USER_A, "one");
    await store.store(USER_A, "two");
    await store.store(USER_B, "still here");
    await store.deleteAll(USER_A);
    expect(await store.list(USER_A)).toEqual([]);
    expect(await store.list(USER_B)).toHaveLength(1);
  });

  it("get returns the memory by id and bumps last_accessed_at", async () => {
    const m = await store.store(USER_A, "find me");
    const before = Date.now();
    const got = await store.get(m.id);
    expect(got?.id).toBe(m.id);
    expect(got?.last_accessed_at).toBeInstanceOf(Date);
    expect(got!.last_accessed_at!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("get returns null for unknown ids", async () => {
    expect(await store.get("never-existed")).toBeNull();
  });

  it("get returns null for expired memories", async () => {
    const m = await store.store(USER_A, "doomed", {
      expires_at: new Date(Date.now() - 1000),
    });
    expect(await store.get(m.id)).toBeNull();
  });
});

describe("MemoryUserMemoryStore — max_memories_per_user eviction", () => {
  it("defaults to DEFAULT_MAX_MEMORIES_PER_USER (200)", () => {
    expect(DEFAULT_MAX_MEMORIES_PER_USER).toBe(200);
  });

  it("does not evict when under the cap", async () => {
    const store = new MemoryUserMemoryStore({ max_memories_per_user: 5 });
    for (let i = 0; i < 5; i++) {
      await store.store(USER_A, "m" + i);
    }
    expect(await store.list(USER_A)).toHaveLength(5);
  });

  it("evicts the lowest-importance memory first when over the cap", async () => {
    const store = new MemoryUserMemoryStore({ max_memories_per_user: 2 });
    await store.store(USER_A, "low", { importance: 1 });
    await store.store(USER_A, "normal", { importance: 2 });
    await store.store(USER_A, "high", { importance: 3 });

    const surviving = (await store.list(USER_A)).map((m) => m.content);
    expect(surviving).toContain("normal");
    expect(surviving).toContain("high");
    expect(surviving).not.toContain("low");
  });

  it("evicts the oldest within the same importance band", async () => {
    const store = new MemoryUserMemoryStore({ max_memories_per_user: 2 });
    await store.store(USER_A, "old", { importance: 2 });
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "mid", { importance: 2 });
    await new Promise((r) => setTimeout(r, 5));
    await store.store(USER_A, "new", { importance: 2 });

    const surviving = (await store.list(USER_A)).map((m) => m.content);
    expect(surviving).toContain("mid");
    expect(surviving).toContain("new");
    expect(surviving).not.toContain("old");
  });

  it("evicts the just-stored memory if it is the worst", async () => {
    const store = new MemoryUserMemoryStore({ max_memories_per_user: 2 });
    await store.store(USER_A, "high-1", { importance: 3 });
    await store.store(USER_A, "high-2", { importance: 3 });
    // Newly-stored low-importance memory should be evicted immediately
    // because it ranks lowest.
    await store.store(USER_A, "low", { importance: 1 });

    const surviving = (await store.list(USER_A)).map((m) => m.content);
    expect(surviving).toEqual(expect.arrayContaining(["high-1", "high-2"]));
    expect(surviving).not.toContain("low");
  });

  it("eviction is per-user — one user filling up does not affect another", async () => {
    const store = new MemoryUserMemoryStore({ max_memories_per_user: 2 });
    for (let i = 0; i < 5; i++) {
      await store.store(USER_A, "a" + i);
    }
    await store.store(USER_B, "b1");

    expect(await store.list(USER_A)).toHaveLength(2);
    expect(await store.list(USER_B)).toHaveLength(1);
  });
});

describe("MemoryUserMemoryStore — factory integration", () => {
  it("createUserMemoryStore('memory') returns a MemoryUserMemoryStore", async () => {
    const { createUserMemoryStore } = await import("../../../src/memory/user/index.js");
    const store = createUserMemoryStore({
      store: "memory",
      max_memories_per_user: 3,
    });
    expect(store).toBeInstanceOf(MemoryUserMemoryStore);

    // Confirm the cap was forwarded.
    for (let i = 0; i < 5; i++) {
      await store.store(USER_A, "m" + i);
    }
    expect(await store.list(USER_A)).toHaveLength(3);
  });

  it("createUserMemoryStore('postgres') throws when TUTTI_PG_URL is unset", async () => {
    const original = process.env.TUTTI_PG_URL;
    delete process.env.TUTTI_PG_URL;
    try {
      const { createUserMemoryStore } = await import("../../../src/memory/user/index.js");
      expect(() => createUserMemoryStore({ store: "postgres" })).toThrow(
        /TUTTI_PG_URL/,
      );
    } finally {
      if (original !== undefined) process.env.TUTTI_PG_URL = original;
    }
  });

  it("createUserMemoryStore throws on an unsupported store name", async () => {
    const { createUserMemoryStore } = await import("../../../src/memory/user/index.js");
    expect(() =>
      createUserMemoryStore({
        // Cast — the type system rules this out, but operators may
        // misconfigure at runtime via raw JSON.
        store: "redis" as unknown as "memory",
      }),
    ).toThrow(/unsupported store/);
  });
});
