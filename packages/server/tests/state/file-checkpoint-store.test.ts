import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint } from "@tuttiai/core";

import { FileCheckpointStore } from "../../src/state/file-checkpoint-store.js";

let dir: string;

function checkpoint(turn: number, over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    session_id: "s1",
    turn,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "danger", input: { path: "a" } }] },
    ],
    tool_results: [{ content: "ok" }],
    state: { next_turn: turn + 1, prompt_tokens_used: 3, completion_tokens_used: 2, pending_tool_ids: ["t1"], awaiting_tool_results: false },
    saved_at: new Date("2026-11-02T20:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutti-checkpoints-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileCheckpointStore", () => {
  it("keeps checkpoints across instances and loads the latest turn", async () => {
    const store = new FileCheckpointStore(dir);
    await store.save(checkpoint(1));
    await store.save(checkpoint(10));
    await store.save(checkpoint(2));
    const after = new FileCheckpointStore(dir);

    expect(await after.loadLatest("s1")).toEqual(checkpoint(10));
    expect(await after.load("s1", 2)).toEqual(checkpoint(2));
    expect(await after.load("s1", 3)).toBeNull();
    expect((await after.list("s1")).map((c) => c.turn)).toEqual([1, 2, 10]);
  });

  it("replaces a checkpoint saved again for the same turn, with mode 0600", async () => {
    const store = new FileCheckpointStore(dir);
    await store.save(checkpoint(1));
    await store.save(checkpoint(1, { tool_results: [{ content: "newer", is_error: true }] }));
    expect((await store.load("s1", 1))?.tool_results).toEqual([{ content: "newer", is_error: true }]);
    expect(readdirSync(join(dir, "s1"))).toEqual(["1.json"]);
    expect(statSync(join(dir, "s1", "1.json")).mode & 0o777).toBe(0o600);
  });

  it("deletes a session's checkpoints", async () => {
    const store = new FileCheckpointStore(dir);
    await store.save(checkpoint(1));
    await store.delete("s1");
    await store.delete("never-saved");
    expect(await store.loadLatest("s1")).toBeNull();
    expect(await store.list("s1")).toEqual([]);
  });

  it("never touches the filesystem for a session id outside the pattern", async () => {
    const store = new FileCheckpointStore(dir);
    await expect(store.save(checkpoint(1, { session_id: "../x" }))).rejects.toThrow("cannot name a file");
    await expect(store.save(checkpoint(-1))).rejects.toThrow("cannot name a file");
    expect(await store.loadLatest("../x")).toBeNull();
    await store.delete("..");
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["bad JSON", "{not json"],
    ["a schema failure", JSON.stringify({ session_id: "s1", turn: 2 })],
    ["a turn that differs from the file name", JSON.stringify({ ...checkpoint(7), saved_at: "2026-11-02T20:00:00.000Z" })],
  ])("treats %s as absent and warns with ids only", async (_label, content) => {
    const warn = vi.fn();
    const store = new FileCheckpointStore(dir, warn);
    await store.save(checkpoint(1));
    writeFileSync(join(dir, "s1", "2.json"), content);

    expect((await store.loadLatest("s1"))?.turn).toBe(1);
    expect(await store.load("s1", 2)).toBeNull();
    expect(warn).toHaveBeenCalledWith({ session: "s1", turn: 2 }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tool_use");
  });

  it("clears temporary files an interrupted write left behind", () => {
    mkdirSync(join(dir, "s1"));
    writeFileSync(join(dir, "s1", "1.json.abc.tmp"), "half");
    new FileCheckpointStore(dir);
    expect(readdirSync(join(dir, "s1"))).toEqual([]);
  });

  it("refuses a directory it cannot write, so the caller can fall back", () => {
    writeFileSync(join(dir, "file"), "");
    expect(() => new FileCheckpointStore(join(dir, "file", "checkpoints"))).toThrow();
  });
});
