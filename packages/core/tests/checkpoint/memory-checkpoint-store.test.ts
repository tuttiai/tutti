import { describe, it, expect } from "vitest";
import type { ChatMessage, ToolResult } from "@tuttiai/types";
import { MemoryCheckpointStore } from "../../src/checkpoint/memory.js";
import type { Checkpoint } from "../../src/checkpoint/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMessage(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: text };
}

function makeToolResult(content: string, is_error = false): ToolResult {
  return { content, ...(is_error ? { is_error } : {}) };
}

function makeCheckpoint(
  session_id: string,
  turn: number,
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    session_id,
    turn,
    messages: [makeMessage("user", "hello"), makeMessage("assistant", "hi")],
    tool_results: [],
    state: {
      next_turn: turn + 1,
      prompt_tokens_used: 100 * turn,
      completion_tokens_used: 50 * turn,
    },
    saved_at: new Date(2026, 3, 13, 12, 0, turn),
    ...overrides,
  };
}

// ===========================================================================

describe("MemoryCheckpointStore", () => {
  describe("save", () => {
    it("persists a checkpoint that loadLatest can retrieve", async () => {
      const store = new MemoryCheckpointStore();
      const cp = makeCheckpoint("s1", 0);

      await store.save(cp);
      const loaded = await store.loadLatest("s1");

      expect(loaded).not.toBeNull();
      expect(loaded?.session_id).toBe("s1");
      expect(loaded?.turn).toBe(0);
      expect(loaded?.state.next_turn).toBe(1);
    });

    it("replaces on duplicate (session_id, turn) rather than duplicating", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      await store.save(
        makeCheckpoint("s1", 0, {
          state: {
            next_turn: 1,
            prompt_tokens_used: 999,
            completion_tokens_used: 999,
          },
        }),
      );

      const all = await store.list("s1");
      expect(all).toHaveLength(1);
      expect(all[0].state.prompt_tokens_used).toBe(999);
    });

    it("isolates checkpoints by session_id", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s2", 0));

      expect(await store.list("s1")).toHaveLength(1);
      expect(await store.list("s2")).toHaveLength(1);
      expect((await store.loadLatest("s1"))?.session_id).toBe("s1");
      expect((await store.loadLatest("s2"))?.session_id).toBe("s2");
    });

    it("deep-clones on save so post-save mutations don't leak into the store", async () => {
      const store = new MemoryCheckpointStore();
      const cp = makeCheckpoint("s1", 0);
      await store.save(cp);

      // Mutate the caller's copy.
      cp.state.prompt_tokens_used = 99999;
      cp.messages.push(makeMessage("user", "leaked"));

      const reloaded = await store.loadLatest("s1");
      expect(reloaded?.state.prompt_tokens_used).toBe(0);
      expect(reloaded?.messages).toHaveLength(2);
    });

    it("preserves Date objects across save/load", async () => {
      const store = new MemoryCheckpointStore();
      const saved_at = new Date(2026, 3, 13, 12, 34, 56);
      await store.save(makeCheckpoint("s1", 0, { saved_at }));

      const loaded = await store.loadLatest("s1");
      expect(loaded?.saved_at).toBeInstanceOf(Date);
      expect(loaded?.saved_at.getTime()).toBe(saved_at.getTime());
    });
  });

  describe("loadLatest", () => {
    it("returns null for an unknown session", async () => {
      const store = new MemoryCheckpointStore();
      expect(await store.loadLatest("nope")).toBeNull();
    });

    it("returns the highest-turn checkpoint (not insertion order)", async () => {
      const store = new MemoryCheckpointStore();
      // Save out of order: 2, 0, 1.
      await store.save(makeCheckpoint("s1", 2));
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s1", 1));

      const latest = await store.loadLatest("s1");
      expect(latest?.turn).toBe(2);
    });

    it("deep-clones the returned checkpoint", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));

      const loaded = await store.loadLatest("s1");
      loaded!.state.prompt_tokens_used = 9999;
      loaded!.messages.push(makeMessage("user", "mutation"));

      const reloaded = await store.loadLatest("s1");
      expect(reloaded?.state.prompt_tokens_used).toBe(0);
      expect(reloaded?.messages).toHaveLength(2);
    });
  });

  describe("load", () => {
    it("returns a specific turn when present", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s1", 1));
      await store.save(makeCheckpoint("s1", 2));

      const mid = await store.load("s1", 1);
      expect(mid?.turn).toBe(1);
    });

    it("returns null for a missing turn", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      expect(await store.load("s1", 5)).toBeNull();
    });

    it("returns null for an unknown session", async () => {
      const store = new MemoryCheckpointStore();
      expect(await store.load("nope", 0)).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes every checkpoint for the session", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s1", 1));
      await store.save(makeCheckpoint("s1", 2));

      await store.delete("s1");

      expect(await store.list("s1")).toEqual([]);
      expect(await store.loadLatest("s1")).toBeNull();
      expect(await store.load("s1", 1)).toBeNull();
    });

    it("leaves other sessions untouched", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s2", 0));

      await store.delete("s1");

      expect(await store.list("s1")).toEqual([]);
      expect(await store.loadLatest("s2")).not.toBeNull();
    });

    it("is a no-op for unknown sessions", async () => {
      const store = new MemoryCheckpointStore();
      await expect(store.delete("never-saved")).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns checkpoints sorted by ascending turn", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 2));
      await store.save(makeCheckpoint("s1", 0));
      await store.save(makeCheckpoint("s1", 3));
      await store.save(makeCheckpoint("s1", 1));

      const all = await store.list("s1");
      expect(all.map((c) => c.turn)).toEqual([0, 1, 2, 3]);
    });

    it("returns an empty array for an unknown session", async () => {
      const store = new MemoryCheckpointStore();
      expect(await store.list("nope")).toEqual([]);
    });

    it("deep-clones each returned entry", async () => {
      const store = new MemoryCheckpointStore();
      await store.save(makeCheckpoint("s1", 0));

      const listed = await store.list("s1");
      listed[0].state.prompt_tokens_used = 9999;

      const relisted = await store.list("s1");
      expect(relisted[0].state.prompt_tokens_used).toBe(0);
    });
  });

  describe("tool_results round-trip", () => {
    it("preserves tool_results across save / load", async () => {
      const store = new MemoryCheckpointStore();
      const tool_results: ToolResult[] = [
        makeToolResult("stdout: hello"),
        makeToolResult("boom", true),
      ];
      await store.save(makeCheckpoint("s1", 0, { tool_results }));

      const loaded = await store.loadLatest("s1");
      expect(loaded?.tool_results).toEqual(tool_results);
    });
  });
});
