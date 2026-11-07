/**
 * Unit tests for {@link PostgresUserModelStore} against a mocked `pg`
 * pool: no database is started. The shared contract runs against a real
 * Postgres in user-model-postgres.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const end = vi.fn(async () => undefined);
const poolOptions: unknown[] = [];

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
      end = end;
      constructor(options: unknown) {
        poolOptions.push(options);
      }
    },
  },
}));

const { PostgresUserModelStore } = await import("../../src/memory/user-model-postgres.js");

const PASSWORD = "s3cr3t-pw";
const URL = "postgres://tutti:" + PASSWORD + "@db.internal:5432/tutti";
const ROW = {
  user_id: "u1",
  summary: "Likes TypeScript",
  preferences: { tone: "terse" },
  ongoing_projects: ["tutti"],
  turn_count: 7,
  last_consolidated_turn: 5,
};

function sqlOf(call: number): string {
  return String(query.mock.calls[call]?.[0]);
}

function createCalls(): number {
  return query.mock.calls.filter((c) => String(c[0]).startsWith("CREATE TABLE")).length;
}

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  end.mockClear();
  poolOptions.length = 0;
});

describe("PostgresUserModelStore", () => {
  describe("constructor", () => {
    it("passes the connection string and a connection timeout to the pool", () => {
      new PostgresUserModelStore({ connection_string: URL });
      expect(poolOptions).toEqual([{ connectionString: URL, connectionTimeoutMillis: 10_000 }]);
    });

    it("opens no connection until the first call", () => {
      new PostgresUserModelStore({ connection_string: URL });
      expect(query).not.toHaveBeenCalled();
    });

    it("rejects a table name that is not an identifier, without the connection string", () => {
      const build = (): unknown =>
        new PostgresUserModelStore({ connection_string: URL, table: "x; DROP TABLE y" });
      expect(build).toThrow(/not a valid identifier/);
      expect(build).not.toThrow(new RegExp(PASSWORD));
    });
  });

  describe("schema", () => {
    it("creates the default table once, however many calls are made", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await Promise.all([store.get("a"), store.get("b"), store.delete("c")]);
      expect(createCalls()).toBe(1);
      expect(sqlOf(0)).toContain("CREATE TABLE IF NOT EXISTS tutti_user_profiles (");
      expect(sqlOf(0)).toContain("user_id TEXT PRIMARY KEY");
    });

    it("uses a custom table name everywhere", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL, table: "my_profiles" });
      await store.upsert(ROW);
      expect(sqlOf(0)).toContain("IF NOT EXISTS my_profiles (");
      expect(sqlOf(1)).toContain("INSERT INTO my_profiles ");
    });

    it("treats a concurrent creation by another process as success", async () => {
      query.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" }));
      const store = new PostgresUserModelStore({ connection_string: URL });
      await expect(store.get("u1")).resolves.toBeNull();
    });
  });

  describe("get", () => {
    it("returns null when no row matches", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await expect(store.get("nobody")).resolves.toBeNull();
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining("WHERE user_id = $1"), ["nobody"]);
    });

    it("maps a row to a fresh profile", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await store.get("u1");
      query.mockResolvedValueOnce({ rows: [ROW] });
      const got = await store.get("u1");
      expect(got).toEqual(ROW);
      expect(got?.preferences).not.toBe(ROW.preferences);
      expect(got?.ongoing_projects).not.toBe(ROW.ongoing_projects);
    });

    it("rejects a malformed row instead of returning it", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await store.get("u1");
      query.mockResolvedValueOnce({ rows: [{ ...ROW, turn_count: "7" }] });
      await expect(store.get("u1")).rejects.toThrow(/turn_count/);
    });
  });

  describe("upsert", () => {
    it("writes one parameterised ON CONFLICT statement", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await store.upsert(ROW);
      const [sql, params] = query.mock.calls[1] ?? [];
      expect(sql).toContain("VALUES ($1, $2, $3::jsonb, $4::text[], $5, $6)");
      expect(sql).toContain("ON CONFLICT (user_id) DO UPDATE SET");
      expect(sql).toContain("updated_at = NOW()");
      expect(params).toEqual(["u1", "Likes TypeScript", '{"tone":"terse"}', ["tutti"], 7, 5]);
    });

    it("never puts a value into the SQL text", async () => {
      const evil = "'; DROP TABLE tutti_user_profiles; --";
      const store = new PostgresUserModelStore({ connection_string: URL });
      await store.upsert({ ...ROW, user_id: evil, summary: evil, preferences: { [evil]: evil } });
      await store.get(evil);
      await store.delete(evil);
      for (const call of query.mock.calls) expect(String(call[0])).not.toContain("DROP");
    });
  });

  describe("delete", () => {
    it("deletes by user_id", async () => {
      const store = new PostgresUserModelStore({ connection_string: URL });
      await store.delete("u1");
      expect(query).toHaveBeenLastCalledWith("DELETE FROM tutti_user_profiles WHERE user_id = $1", ["u1"]);
    });
  });

  describe("close", () => {
    it("ends the pool", async () => {
      await new PostgresUserModelStore({ connection_string: URL }).close();
      expect(end).toHaveBeenCalledTimes(1);
    });
  });

  describe("when Postgres cannot be reached", () => {
    it("rejects every method with the driver's error", async () => {
      query.mockRejectedValue(refused());
      const store = new PostgresUserModelStore({ connection_string: URL });
      await expect(store.get("u1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      await expect(store.upsert(ROW)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      await expect(store.delete("u1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    });

    it("retries the bootstrap on the next call once Postgres is back", async () => {
      query.mockRejectedValueOnce(refused());
      const store = new PostgresUserModelStore({ connection_string: URL });
      await expect(store.get("u1")).rejects.toThrow(/ECONNREFUSED/);
      await expect(store.get("u1")).resolves.toBeNull();
      expect(createCalls()).toBe(2);
    });

    it("adds neither the connection string nor the password to the error", async () => {
      query.mockRejectedValue(refused());
      const store = new PostgresUserModelStore({ connection_string: URL });
      const err: unknown = await store.get("u1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err) + String(err)).not.toContain(PASSWORD);
      expect(String(err)).not.toContain("db.internal");
    });
  });
});
