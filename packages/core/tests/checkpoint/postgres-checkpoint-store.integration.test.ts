import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { ChatMessage, ToolResult } from "@tuttiai/types";
import { SecretsManager } from "../../src/secrets.js";
import { PostgresCheckpointStore } from "../../src/checkpoint/postgres.js";
import type { Checkpoint } from "../../src/checkpoint/types.js";

/**
 * Integration tests — require Postgres. Enable with:
 *
 *   TUTTI_PG_URL=postgres://postgres:postgres@localhost:5432/tutti_test npm test
 *
 * Uses a per-run table name so parallel runs don't collide.
 */

const PG_URL = SecretsManager.optional("TUTTI_PG_URL");
const suite = PG_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "tutti_checkpoints_test_" + suffix;

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: text };
}

function toolResult(content: string): ToolResult {
  return { content };
}

function mkCheckpoint(
  session_id: string,
  turn: number,
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    session_id,
    turn,
    messages: [msg("user", "hi"), msg("assistant", "hello")],
    tool_results: [],
    state: {
      next_turn: turn + 1,
      prompt_tokens_used: 10 * turn,
      completion_tokens_used: 5 * turn,
    },
    saved_at: new Date(2026, 3, 13, 12, 0, turn),
    ...overrides,
  };
}

suite("PostgresCheckpointStore (integration)", () => {
  let store: PostgresCheckpointStore;
  const sessionId = "sess-" + suffix;

  beforeAll(() => {
    store = new PostgresCheckpointStore({
      connection_string: PG_URL!,
      table: TABLE,
      ttl_seconds: 300,
    });
  });

  afterAll(async () => {
    // Drop the per-run table. Use a fresh pool so we don't race with the
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
    await store.save(mkCheckpoint(sessionId, 0));
    const loaded = await store.loadLatest(sessionId);
    expect(loaded?.turn).toBe(0);
  });

  it("upsert replaces an existing (session_id, turn)", async () => {
    await store.save(mkCheckpoint(sessionId, 0));
    await store.save(
      mkCheckpoint(sessionId, 0, {
        state: {
          next_turn: 1,
          prompt_tokens_used: 999,
          completion_tokens_used: 999,
        },
      }),
    );

    const all = (await store.list(sessionId)).filter((c) => c.turn === 0);
    expect(all).toHaveLength(1);
    expect(all[0]!.state.prompt_tokens_used).toBe(999);
  });

  it("loadLatest returns the highest turn", async () => {
    await store.save(mkCheckpoint(sessionId, 1));
    await store.save(mkCheckpoint(sessionId, 2));
    const latest = await store.loadLatest(sessionId);
    expect(latest?.turn).toBe(2);
  });

  it("list returns rows in ascending turn order", async () => {
    const all = await store.list(sessionId);
    const turns = all.map((c) => c.turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
  });

  it("trims the session to the 10 most-recent turns on save", async () => {
    const trimId = sessionId + "-trim";
    // Save 15 turns; only the last 10 should survive.
    for (let t = 0; t < 15; t++) {
      await store.save(mkCheckpoint(trimId, t));
    }
    const survivors = (await store.list(trimId)).map((c) => c.turn);
    expect(survivors).toHaveLength(10);
    expect(survivors).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("preserves tool_results across save / load", async () => {
    const cp = mkCheckpoint(sessionId, 3, {
      tool_results: [toolResult("one"), toolResult("two")],
    });
    await store.save(cp);
    const loaded = await store.load(sessionId, 3);
    expect(loaded?.tool_results).toEqual(cp.tool_results);
  });

  it("delete removes every row for the session", async () => {
    const id2 = sessionId + "-del";
    await store.save(mkCheckpoint(id2, 0));
    await store.save(mkCheckpoint(id2, 1));
    await store.delete(id2);

    expect(await store.list(id2)).toEqual([]);
    expect(await store.loadLatest(id2)).toBeNull();
  });

  it("returns null for missing turns and sessions", async () => {
    expect(await store.load(sessionId, 9999)).toBeNull();
    expect(await store.loadLatest("never-saved-" + suffix)).toBeNull();
  });
});

describe("PostgresCheckpointStore constructor", () => {
  it("rejects invalid table identifiers", () => {
    expect(
      () =>
        new PostgresCheckpointStore({
          connection_string: "postgres://x",
          table: "drop; --",
        }),
    ).toThrow(/identifier/);
  });
});
