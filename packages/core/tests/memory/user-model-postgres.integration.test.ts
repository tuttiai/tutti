import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SecretsManager } from "../../src/secrets.js";
import { PostgresUserModelStore } from "../../src/memory/user-model-postgres.js";
import { runUserModelStoreContract } from "../helpers/user-model-store-contract.js";

/**
 * Integration tests: require Postgres. Enable with:
 *
 *   TUTTI_PG_URL=postgres://postgres:postgres@localhost:5432/tutti_test npm test
 *
 * Uses per-run table names so parallel runs don't collide, and drops
 * them on teardown without touching anyone else's data.
 */

const PG_URL = SecretsManager.optional("TUTTI_PG_URL") ?? "";
const suite = PG_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "tutti_user_profiles_test_" + suffix;
const FRESH = "tutti_user_profiles_fresh_" + suffix;
const RACE = "tutti_user_profiles_race_" + suffix;

function makeStore(table: string): PostgresUserModelStore {
  return new PostgresUserModelStore({ connection_string: PG_URL, table });
}

async function adminQuery<R extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
  const admin = new pg.Pool({ connectionString: PG_URL });
  try {
    return (await admin.query<R>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await adminQuery<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [table]);
  return rows[0]?.found === true;
}

suite("PostgresUserModelStore (integration)", () => {
  afterAll(async () => {
    for (const t of [TABLE, FRESH, RACE]) await adminQuery("DROP TABLE IF EXISTS " + t);
  });

  runUserModelStoreContract("PostgresUserModelStore", () => {
    const store = makeStore(TABLE);
    return Promise.resolve({ store, cleanup: () => store.close() });
  });

  it("creates its table on first use, even for a read", async () => {
    const store = makeStore(FRESH);
    try {
      expect(await tableExists(FRESH)).toBe(false);
      await expect(store.get("nobody")).resolves.toBeNull();
      expect(await tableExists(FRESH)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("bootstraps from several instances at once without error or data loss", async () => {
    const stores = Array.from({ length: 4 }, () => makeStore(RACE));
    try {
      await Promise.all(stores.map((s, i) => s.upsert({
        user_id: "u" + String(i), summary: "", preferences: {}, ongoing_projects: [], turn_count: i, last_consolidated_turn: 0,
      })));
      const rows = await adminQuery<{ n: number }>("SELECT COUNT(*)::int AS n FROM " + RACE);
      expect(rows[0]?.n).toBe(4);
    } finally {
      await Promise.all(stores.map((s) => s.close()));
    }
  });

  it("keeps exactly one row after 10 concurrent upserts for one user", async () => {
    const store = makeStore(TABLE);
    try {
      const id = "race-" + suffix;
      await Promise.all(Array.from({ length: 10 }, (_, i) => store.upsert({
        user_id: id, summary: String(i), preferences: {}, ongoing_projects: [], turn_count: i, last_consolidated_turn: 0,
      })));
      const rows = await adminQuery<{ n: number }>("SELECT COUNT(*)::int AS n FROM " + TABLE + " WHERE user_id = $1", [id]);
      expect(rows[0]?.n).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("refuses a NUL character with the driver's error", async () => {
    const store = makeStore(TABLE);
    try {
      await expect(store.upsert({
        user_id: "nul-" + suffix, summary: "a\u0000b", preferences: {}, ongoing_projects: [], turn_count: 0, last_consolidated_turn: 0,
      })).rejects.toThrow();
    } finally {
      await store.close();
    }
  });

  it("rejects with an error free of the password when the server is unreachable", async () => {
    const store = new PostgresUserModelStore({
      connection_string: "postgres://tutti:topsecretpw@127.0.0.1:1/tutti",
    });
    try {
      const err: unknown = await store.get("u").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).not.toContain("topsecretpw");
    } finally {
      await store.close();
    }
  });
});
