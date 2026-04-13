import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage, ToolResult } from "@tuttiai/types";
import { SecretsManager } from "../../src/secrets.js";
import { RedisCheckpointStore } from "../../src/checkpoint/redis.js";
import type { Checkpoint } from "../../src/checkpoint/types.js";

/**
 * Integration tests — require a reachable Redis. Enabled by setting
 * `TUTTI_REDIS_URL`, e.g.:
 *
 *   TUTTI_REDIS_URL=redis://127.0.0.1:6379/15 npm test
 *
 * Each run uses a per-run key prefix so parallel runs don't clobber.
 */

const REDIS_URL = SecretsManager.optional("TUTTI_REDIS_URL");
const suite = REDIS_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const PREFIX = "tutti:checkpoint_test_" + suffix;

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

suite("RedisCheckpointStore (integration)", () => {
  let store: RedisCheckpointStore;
  const sessionId = "sess-" + suffix;

  beforeAll(async () => {
    store = new RedisCheckpointStore({
      url: REDIS_URL!,
      key_prefix: PREFIX,
      // Short TTL so test garbage expires quickly if cleanup is skipped.
      ttl_seconds: 300,
    });
    await store.connect();
  });

  afterAll(async () => {
    await store.delete(sessionId);
    await store.close();
  });

  it("round-trips a checkpoint through save → loadLatest", async () => {
    const cp = mkCheckpoint(sessionId, 0);
    await store.save(cp);

    const loaded = await store.loadLatest(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.turn).toBe(0);
    expect(loaded?.saved_at).toBeInstanceOf(Date);
    expect(loaded?.saved_at.getTime()).toBe(cp.saved_at.getTime());
  });

  it("load(sid, turn) returns the specific turn", async () => {
    await store.save(mkCheckpoint(sessionId, 1));
    await store.save(mkCheckpoint(sessionId, 2));

    const mid = await store.load(sessionId, 1);
    expect(mid?.turn).toBe(1);
    expect(mid?.state.prompt_tokens_used).toBe(10);

    const latest = await store.loadLatest(sessionId);
    expect(latest?.turn).toBe(2);
  });

  it("returns null for missing turns and sessions", async () => {
    expect(await store.load(sessionId, 9999)).toBeNull();
    expect(await store.loadLatest("missing-" + suffix)).toBeNull();
  });

  it("list returns every turn sorted ascending", async () => {
    const all = await store.list(sessionId);
    const turns = all.map((c) => c.turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    expect(turns).toContain(0);
    expect(turns).toContain(1);
    expect(turns).toContain(2);
  });

  it("preserves tool_results across save / load", async () => {
    const cp = mkCheckpoint(sessionId, 3, {
      tool_results: [toolResult("stdout: a"), toolResult("stdout: b")],
    });
    await store.save(cp);

    const loaded = await store.load(sessionId, 3);
    expect(loaded?.tool_results).toEqual(cp.tool_results);
  });

  it("delete removes every key for the session", async () => {
    const id2 = sessionId + "-del";
    await store.save(mkCheckpoint(id2, 0));
    await store.save(mkCheckpoint(id2, 1));
    await store.delete(id2);

    expect(await store.list(id2)).toEqual([]);
    expect(await store.loadLatest(id2)).toBeNull();
  });
});

describe("RedisCheckpointStore constructor", () => {
  it("rejects session IDs with disallowed characters on save", async () => {
    const s = new RedisCheckpointStore({
      url: REDIS_URL ?? "redis://127.0.0.1:6379/15",
      key_prefix: PREFIX + "-unit",
      ttl_seconds: 10,
    });
    // We don't connect — the validation happens before any I/O.
    await expect(
      s.save(mkCheckpoint("bad:id:with:colons", 0)),
    ).rejects.toThrow(/disallowed characters/);
  });
});
