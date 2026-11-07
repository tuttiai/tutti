/**
 * Unit tests for {@link PostgresUserMemoryStore}'s `last_accessed_at`
 * handling, against a mocked `pg` pool: no database is started. The mock
 * answers by SQL text, never by call order, so the bootstrap queries
 * cannot shift it. The JS clock is faked so the time the mocked UPDATE
 * "writes" is exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  user_id: string;
  content: string;
  source: string;
  importance: number;
  tags: string[] | null;
  created_at: Date;
  last_accessed_at: Date | null;
  expires_at: Date | null;
}

const query = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
      end = vi.fn(async () => undefined);
    },
  },
}));

const { PostgresUserMemoryStore } = await import("../../../src/memory/user/postgres-store.js");

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const EARLIER = new Date("2026-02-01T00:00:00.000Z");
const T1 = new Date("2026-03-01T12:00:00.000Z");

let selectRows: Row[] = [];
let updateSkips: Set<string> = new Set();

function row(id: string, last_accessed_at: Date | null = null): Row {
  return {
    id,
    user_id: "u1",
    content: "memory " + id,
    source: "explicit",
    importance: 2,
    tags: null,
    created_at: CREATED,
    last_accessed_at,
    expires_at: null,
  };
}

function idsOf(params: unknown): string[] {
  const first: unknown = Array.isArray(params) ? params[0] : undefined;
  return Array.isArray(first) ? first.filter((x): x is string => typeof x === "string") : [];
}

/** Answers like Postgres would; the UPDATE returns its rows in reverse to prove order is kept. */
function answer(sql: string, params?: unknown): { rows: unknown[] } {
  if (sql.startsWith("UPDATE")) {
    const ids = idsOf(params).filter((id) => !updateSkips.has(id));
    return { rows: ids.reverse().map((id) => ({ id, last_accessed_at: new Date() })) };
  }
  if (sql.includes("pg_extension")) return { rows: [{ has: false }] };
  if (sql.startsWith("SELECT")) return { rows: selectRows };
  return { rows: [] };
}

function updateCalls(): unknown[][] {
  return query.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("UPDATE"));
}

function newStore(): InstanceType<typeof PostgresUserMemoryStore> {
  return new PostgresUserMemoryStore({ connection_string: "postgres://test" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T1);
  selectRows = [];
  updateSkips = new Set();
  query.mockReset();
  query.mockImplementation((sql: string, params?: unknown) => Promise.resolve(answer(sql, params)));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PostgresUserMemoryStore.get", () => {
  it("returns the last_accessed_at the UPDATE wrote, not the null it read", async () => {
    selectRows = [row("a")];
    const got = await newStore().get("a");

    expect(got?.last_accessed_at).toBeInstanceOf(Date);
    expect(got?.last_accessed_at?.getTime()).toBe(T1.getTime());
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]?.[0]).toContain("RETURNING id, last_accessed_at");
    expect(updateCalls()[0]?.[1]).toEqual([["a"]]);
  });

  it("returns null for an unknown id and sends no UPDATE", async () => {
    selectRows = [];
    await expect(newStore().get("missing")).resolves.toBeNull();
    expect(updateCalls()).toHaveLength(0);
  });

  it("keeps the value as read when the UPDATE reaches no row", async () => {
    selectRows = [row("a", EARLIER)];
    updateSkips = new Set(["a"]);
    const got = await newStore().get("a");

    expect(got?.last_accessed_at?.getTime()).toBe(EARLIER.getTime());
  });

  it("leaves last_accessed_at out when the UPDATE misses a row never read before", async () => {
    selectRows = [row("a")];
    updateSkips = new Set(["a"]);
    const got = await newStore().get("a");

    expect(got).not.toBeNull();
    expect(got).not.toHaveProperty("last_accessed_at");
  });
});

describe("PostgresUserMemoryStore.search", () => {
  it("returns every hit with the time the UPDATE wrote, in SELECT order", async () => {
    selectRows = [row("a"), row("b", EARLIER), row("c")];
    const hits = await newStore().search("u1", "memory");

    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    for (const h of hits) expect(h.last_accessed_at?.getTime()).toBe(T1.getTime());
  });

  it("bumps only the hits: the UPDATE names exactly the returned ids", async () => {
    selectRows = [row("a"), row("c")];
    await newStore().search("u1", "memory");

    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]?.[1]).toEqual([["a", "c"]]);
  });

  it("sends no UPDATE when nothing matches", async () => {
    selectRows = [];
    await expect(newStore().search("u1", "nothing")).resolves.toEqual([]);
    expect(updateCalls()).toHaveLength(0);
  });

  it("sends no UPDATE for a blank query", async () => {
    await expect(newStore().search("u1", "   ")).resolves.toEqual([]);
    expect(updateCalls()).toHaveLength(0);
  });

  it("keeps the value as read for a hit the UPDATE did not reach", async () => {
    selectRows = [row("a", EARLIER), row("b")];
    updateSkips = new Set(["a"]);
    const hits = await newStore().search("u1", "memory");

    expect(hits[0]?.last_accessed_at?.getTime()).toBe(EARLIER.getTime());
    expect(hits[1]?.last_accessed_at?.getTime()).toBe(T1.getTime());
  });

  it("passes the query text as a parameter, never in the SQL", async () => {
    const hostile = "x'; DROP TABLE tutti_user_memories; --";
    await newStore().search("u1", hostile);

    const select = query.mock.calls.find((c: unknown[]) => String(c[0]).includes("ILIKE"));
    expect(String(select?.[0])).not.toContain("DROP TABLE");
    expect(select?.[1]).toEqual(["u1", hostile, 10]);
  });
});
