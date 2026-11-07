import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SecretsManager } from "../../../src/secrets.js";
import { MemoryUserMemoryStore } from "../../../src/memory/user/memory-store.js";
import { PostgresUserMemoryStore } from "../../../src/memory/user/postgres-store.js";
import type { UserMemoryStore } from "../../../src/memory/user/types.js";

/**
 * Integration tests for the `last_accessed_at` that `get` and `search`
 * return (tutti#66). Require Postgres; enable with `TUTTI_PG_URL`. The
 * time comes from the database's `NOW()`, which a fake JS clock cannot
 * reach, so each assertion is "a Date, not before the call, equal to the
 * stored value", never an exact time. No real waits.
 */

const PG_URL = SecretsManager.optional("TUTTI_PG_URL");
const suite = PG_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "tutti_user_memories_access_" + suffix;
const USER = "user-access-" + suffix;

/**
 * Whether `last_accessed_at` is set after each step: store, the search hit,
 * a non-hit seen through `list`, then `get`. Read at each step, because the
 * in-memory store bumps the objects it handed out earlier in place.
 */
async function accessTrace(store: UserMemoryStore, user: string): Promise<boolean[]> {
  const set = (m: { last_accessed_at?: Date } | null | undefined): boolean =>
    m?.last_accessed_at instanceof Date;
  const hit = await store.store(user, "parity marker " + suffix);
  const trace = [set(hit)];
  const miss = await store.store(user, "unrelated note");
  trace.push(set((await store.search(user, "parity marker " + suffix)).find((h) => h.id === hit.id)));
  trace.push(set((await store.list(user)).find((m) => m.id === miss.id)));
  trace.push(set(await store.get(miss.id)));
  return trace;
}

suite("PostgresUserMemoryStore last_accessed_at (integration)", () => {
  let store: PostgresUserMemoryStore;
  let admin: InstanceType<typeof pg.Pool>;

  async function stored(id: string): Promise<Date | null | undefined> {
    const result = await admin.query<{ last_accessed_at: Date | null }>(
      "SELECT last_accessed_at FROM " + TABLE + " WHERE id = $1",
      [id],
    );
    return result.rows[0]?.last_accessed_at;
  }

  beforeAll(() => {
    store = new PostgresUserMemoryStore({ connection_string: PG_URL ?? "", table: TABLE });
    admin = new pg.Pool({ connectionString: PG_URL ?? "" });
  });

  afterAll(async () => {
    try {
      await admin.query("DROP TABLE IF EXISTS " + TABLE);
    } finally {
      await admin.end();
      await store.close();
    }
  });

  it("get returns the last_accessed_at it stored, not before the call", async () => {
    const m = await store.store(USER, "get marker " + suffix);
    const before = Date.now();
    const got = await store.get(m.id);

    expect(got?.last_accessed_at).toBeInstanceOf(Date);
    expect(got?.last_accessed_at?.getTime()).toBeGreaterThanOrEqual(before);
    expect(got?.last_accessed_at?.getTime()).toBe((await stored(m.id))?.getTime());
  });

  it("search returns each hit's stored last_accessed_at and leaves non-hits alone", async () => {
    const hit = await store.store(USER, "search marker " + suffix);
    const other = await store.store(USER, "something else entirely");
    const before = Date.now();
    const found = (await store.search(USER, "search marker " + suffix)).find((h) => h.id === hit.id);

    expect(found?.last_accessed_at).toBeInstanceOf(Date);
    expect(found?.last_accessed_at?.getTime()).toBeGreaterThanOrEqual(before);
    expect(found?.last_accessed_at?.getTime()).toBe((await stored(hit.id))?.getTime());
    expect(await stored(other.id)).toBeNull();
  });

  it("get on an unknown id returns null and writes no row", async () => {
    const id = "never-existed-" + suffix;
    expect(await store.get(id)).toBeNull();
    expect(await stored(id)).toBeUndefined();
  });

  it("agrees with MemoryUserMemoryStore on when last_accessed_at is set", async () => {
    const pgTrace = await accessTrace(store, "parity-pg-" + suffix);
    const memoryTrace = await accessTrace(new MemoryUserMemoryStore(), "parity-mem-" + suffix);

    expect(pgTrace).toEqual([false, true, false, true]);
    expect(memoryTrace).toEqual(pgTrace);
  });
});
