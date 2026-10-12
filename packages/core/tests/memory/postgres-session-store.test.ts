/**
 * Unit tests for {@link PostgresSessionStore}'s cache and `load`, against a
 * mocked `pg` pool: no database is started.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = query;
      end = vi.fn(async () => undefined);
    },
  },
}));

const { PostgresSessionStore } = await import("../../src/memory/postgres.js");

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe("PostgresSessionStore", () => {
  describe("get", () => {
    it("returns a session it created", () => {
      const store = new PostgresSessionStore("postgres://test");
      const session = store.create("agent");

      expect(store.get(session.id)).toBe(session);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO tutti_sessions"), expect.any(Array));
    });

    it("returns a session's messages after an update", () => {
      const store = new PostgresSessionStore("postgres://test");
      const session = store.create("agent");
      const messages = [{ role: "user" as const, content: "hello" }];

      store.update(session.id, messages);

      expect(store.get(session.id)?.messages).toEqual(messages);
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining("UPDATE tutti_sessions"), [
        JSON.stringify(messages),
        session.id,
      ]);
    });

    it("returns undefined for a session only the database holds", () => {
      expect(new PostgresSessionStore("postgres://test").get("elsewhere")).toBeUndefined();
    });

    it("bounds the cache without touching the table", () => {
      const store = new PostgresSessionStore("postgres://test", { max_sessions: 1 });
      const first = store.create("agent");
      store.create("agent");

      expect(store.get(first.id)).toBeUndefined();
      expect(query).not.toHaveBeenCalledWith(expect.stringContaining("DELETE"), expect.anything());
    });
  });

  describe("load", () => {
    it("reads a session from the database and caches it for get and update", async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: "s1",
            agent_name: "agent",
            messages: [{ role: "user", content: "earlier" }],
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-02T00:00:00.000Z",
          },
        ],
      });
      const store = new PostgresSessionStore("postgres://test");

      const loaded = await store.load("s1");

      expect(loaded?.messages).toEqual([{ role: "user", content: "earlier" }]);
      expect(loaded?.created_at).toEqual(new Date("2026-10-01T00:00:00.000Z"));
      expect(store.get("s1")).toBe(loaded);
      store.update("s1", []);
      expect(store.get("s1")?.messages).toEqual([]);
    });

    it("answers from the cache without a query", async () => {
      const store = new PostgresSessionStore("postgres://test");
      const session = store.create("agent");
      query.mockClear();

      expect(await store.load(session.id)).toBe(session);
      expect(query).not.toHaveBeenCalled();
    });

    it("returns undefined when the table holds no such session", async () => {
      expect(await new PostgresSessionStore("postgres://test").load("missing")).toBeUndefined();
    });
  });
});
