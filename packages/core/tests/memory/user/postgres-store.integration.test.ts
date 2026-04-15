import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SecretsManager } from "../../../src/secrets.js";
import { PostgresUserMemoryStore } from "../../../src/memory/user/postgres-store.js";

/**
 * Integration tests — require Postgres. Enable with:
 *
 *   TUTTI_PG_URL=postgres://postgres:postgres@localhost:5432/tutti_test npm test
 *
 * Uses a per-run table name so parallel runs don't collide and the
 * suite can drop its own table on teardown without touching anyone
 * else's data.
 */

const PG_URL = SecretsManager.optional("TUTTI_PG_URL");
const suite = PG_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "tutti_user_memories_test_" + suffix;

const USER_A = "user-a-" + suffix;
const USER_B = "user-b-" + suffix;

suite("PostgresUserMemoryStore (integration)", () => {
  let store: PostgresUserMemoryStore;

  beforeAll(() => {
    store = new PostgresUserMemoryStore({
      connection_string: PG_URL!,
      table: TABLE,
      max_memories_per_user: 100,
    });
  });

  afterAll(async () => {
    // Drop the per-run table from a fresh pool so we don't race with the
    // store's own pool shutdown.
    const admin = new pg.Pool({ connectionString: PG_URL! });
    try {
      await admin.query("DROP TABLE IF EXISTS " + TABLE);
    } finally {
      await admin.end();
      await store.close();
    }
  });

  it("auto-creates the table on first use", async () => {
    const m = await store.store(USER_A, "User prefers TypeScript");
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.user_id).toBe(USER_A);
    expect(m.content).toBe("User prefers TypeScript");
    expect(m.source).toBe("explicit");
    expect(m.importance).toBe(2);
    expect(m.created_at).toBeInstanceOf(Date);
  });

  it("round-trips every StoreOptions field via get()", async () => {
    const expires = new Date(Date.now() + 60_000);
    const stored = await store.store(USER_A, "Lives in Berlin", {
      source: "inferred",
      importance: 3,
      tags: ["location", "profile"],
      expires_at: expires,
    });

    const got = await store.get(stored.id);
    expect(got).not.toBeNull();
    expect(got!.content).toBe("Lives in Berlin");
    expect(got!.source).toBe("inferred");
    expect(got!.importance).toBe(3);
    expect(got!.tags).toEqual(["location", "profile"]);
    // Postgres rounds to ms — compare epoch-ms.
    expect(got!.expires_at?.getTime()).toBe(expires.getTime());
  });

  it("get returns null for unknown ids", async () => {
    expect(await store.get("never-existed-" + suffix)).toBeNull();
  });

  it("get bumps last_accessed_at", async () => {
    const m = await store.store(USER_A, "Loves coffee");
    expect(m.last_accessed_at).toBeUndefined();
    const got = await store.get(m.id);
    expect(got!.last_accessed_at).toBeInstanceOf(Date);
  });

  it("search finds memories by ILIKE / trigram match (path-agnostic)", async () => {
    await store.store(USER_A, "Prefers React over Vue");
    await store.store(USER_A, "Strong opinions about TypeScript");

    const hits = await store.search(USER_A, "typescript");
    // The match is case-insensitive regardless of which path is taken.
    expect(hits.some((h) => h.content.toLowerCase().includes("typescript"))).toBe(true);
  });

  it("search returns nothing for an empty query", async () => {
    expect(await store.search(USER_A, "")).toEqual([]);
    expect(await store.search(USER_A, "   ")).toEqual([]);
  });

  it("search isolates results by user_id", async () => {
    await store.store(USER_B, "Different user, same keyword: Berlin");
    const hits = await store.search(USER_A, "Berlin");
    expect(hits.every((h) => h.user_id === USER_A)).toBe(true);
  });

  it("search bumps last_accessed_at on every hit", async () => {
    const m = await store.store(USER_A, "Pinpoint timestamp marker " + suffix);
    expect((await store.get(m.id))!.last_accessed_at).toBeInstanceOf(Date);
    const before = await store.get(m.id);
    await new Promise((r) => setTimeout(r, 20));
    const hits = await store.search(USER_A, "pinpoint timestamp marker " + suffix);
    const found = hits.find((h) => h.id === m.id);
    expect(found).toBeDefined();
    expect(found!.last_accessed_at!.getTime()).toBeGreaterThanOrEqual(
      before!.last_accessed_at!.getTime(),
    );
  });

  it("search respects the limit argument", async () => {
    // Seed five obviously matching memories.
    for (let i = 0; i < 5; i++) {
      await store.store(USER_A, "limit-test-marker-" + suffix + " " + i);
    }
    const limited = await store.search(USER_A, "limit-test-marker-" + suffix, 3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it("list returns memories most-recently-created first", async () => {
    const userC = "user-c-" + suffix;
    await store.store(userC, "first");
    await new Promise((r) => setTimeout(r, 5));
    await store.store(userC, "second");
    await new Promise((r) => setTimeout(r, 5));
    await store.store(userC, "third");

    const all = await store.list(userC);
    expect(all.map((m) => m.content)).toEqual(["third", "second", "first"]);
  });

  it("list excludes expired rows", async () => {
    const userD = "user-d-" + suffix;
    await store.store(userD, "alive");
    await store.store(userD, "stale", {
      expires_at: new Date(Date.now() - 1000),
    });
    // The next store() schedules a background expired-row sweep, but
    // the list query also filters expired rows in-band — so the result
    // is correct regardless of sweep timing.
    const all = await store.list(userD);
    expect(all.map((m) => m.content)).toEqual(["alive"]);
  });

  it("delete removes by id and is idempotent on unknown ids", async () => {
    const m = await store.store(USER_A, "doomed " + suffix);
    await store.delete(m.id);
    expect(await store.get(m.id)).toBeNull();
    // Idempotent — second delete is a no-op.
    await expect(store.delete(m.id)).resolves.toBeUndefined();
    await expect(store.delete("never-existed-" + suffix)).resolves.toBeUndefined();
  });

  it("deleteAll wipes every memory for the user", async () => {
    const userE = "user-e-" + suffix;
    await store.store(userE, "one");
    await store.store(userE, "two");
    await store.deleteAll(userE);
    expect(await store.list(userE)).toEqual([]);
  });

  it("auto-deletes expired rows in the background after store()", async () => {
    const userF = "user-f-" + suffix;
    await store.store(userF, "stale", {
      expires_at: new Date(Date.now() - 1000),
    });
    // Trigger the background sweep by storing another row.
    await store.store(userF, "trigger sweep");

    // Wait briefly for the fire-and-forget DELETE to land. The sweep is
    // unconditional so this is deterministic once the round-trip completes.
    await new Promise((r) => setTimeout(r, 200));

    // Probe the table directly — list() filters expired rows in-band so
    // it can't distinguish "sweep ran" from "filtered at query time".
    const admin = new pg.Pool({ connectionString: PG_URL! });
    try {
      const result = await admin.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM " + TABLE +
          " WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()",
        [userF],
      );
      expect(parseInt(result.rows[0]!.count, 10)).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it("max_memories_per_user evicts lowest-importance memories first", async () => {
    const cappedStore = new PostgresUserMemoryStore({
      connection_string: PG_URL!,
      table: TABLE,
      max_memories_per_user: 2,
    });
    const userG = "user-g-" + suffix;

    try {
      await cappedStore.store(userG, "low", { importance: 1 });
      await cappedStore.store(userG, "normal", { importance: 2 });
      await cappedStore.store(userG, "high", { importance: 3 });

      // enforceCap is fire-and-forget — give it a beat to land.
      await new Promise((r) => setTimeout(r, 200));

      const surviving = (await cappedStore.list(userG)).map((m) => m.content);
      expect(surviving).toContain("normal");
      expect(surviving).toContain("high");
      expect(surviving).not.toContain("low");
    } finally {
      await cappedStore.close();
    }
  });

  it("rejects invalid table identifiers in the constructor", () => {
    expect(
      () =>
        new PostgresUserMemoryStore({
          connection_string: "postgres://x",
          table: "drop; --",
        }),
    ).toThrow(/identifier/);
  });
});
