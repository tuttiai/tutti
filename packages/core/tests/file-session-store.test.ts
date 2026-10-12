/**
 * Unit tests for {@link FileSessionStore}: sessions kept one file each in a
 * directory, so they survive a new store on the same directory.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@tuttiai/types";

import { FileSessionStore } from "../src/file-session-store.js";

const HISTORY: ChatMessage[] = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "look", input: { q: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }] },
];

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tutti-file-sessions-"));
  dir = join(root, "state", "sessions");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  describe("create, get and update", () => {
    it("creates the directory and writes one file per session", () => {
      const store = new FileSessionStore(dir);
      const session = store.create("agent");

      expect(readdirSync(dir)).toEqual([`${session.id}.json`]);
      expect(store.get(session.id)).toBe(session);
    });

    it("round-trips messages and revives dates in a new store on the same directory", () => {
      const first = new FileSessionStore(dir);
      const session = first.create("agent");
      first.update(session.id, HISTORY);

      const loaded = new FileSessionStore(dir).get(session.id);

      expect(loaded?.messages).toEqual(HISTORY);
      expect(loaded?.agent_name).toBe("agent");
      expect(loaded?.created_at).toBeInstanceOf(Date);
      expect(loaded?.created_at.getTime()).toBe(session.created_at.getTime());
      expect(loaded?.updated_at.getTime()).toBe(session.updated_at.getTime());
    });

    it("updates a session read from disk", () => {
      const session = new FileSessionStore(dir).create("agent");
      const second = new FileSessionStore(dir);
      second.update(session.id, HISTORY);

      expect(new FileSessionStore(dir).get(session.id)?.messages).toEqual(HISTORY);
    });

    it("refuses a directory it cannot create", () => {
      writeFileSync(join(root, "state"), "a file where the directory should be");

      expect(() => new FileSessionStore(dir)).toThrow();
    });

    it.skipIf(process.getuid?.() === 0)("refuses a directory it may not write", () => {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      try {
        expect(() => new FileSessionStore(dir)).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it("throws when updating a session it does not hold", () => {
      expect(() => new FileSessionStore(dir).update("missing", [])).toThrow("Session not found: missing");
    });

    it("saves a session under its own id", () => {
      const now = new Date();
      new FileSessionStore(dir).save({ id: "kept_1", agent_name: "a", messages: HISTORY, created_at: now, updated_at: now });

      expect(new FileSessionStore(dir).get("kept_1")?.messages).toEqual(HISTORY);
    });

    it("leaves no temporary file behind and clears abandoned ones", () => {
      const store = new FileSessionStore(dir);
      store.create("agent");
      writeFileSync(join(dir, "abc.json.123.tmp"), "half");

      new FileSessionStore(dir);

      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("bounds", () => {
    it("deletes the least recently used session's file over the cap", () => {
      const store = new FileSessionStore(dir, { max_sessions: 2 });
      const a = store.create("agent");
      const b = store.create("agent");
      store.get(a.id);
      store.create("agent");

      expect(existsSync(join(dir, `${b.id}.json`))).toBe(false);
      expect(store.get(b.id)).toBeUndefined();
      expect(store.get(a.id)).toBe(a);
    });

    it("deletes a session idle past its time to live", () => {
      let now = Date.now();
      const store = new FileSessionStore(dir, { idle_ttl_ms: 1_000, now: () => now });
      const session = store.create("agent");
      now += 1_001;

      expect(store.get(session.id)).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    });

    it("drops files last written longer ago than the time to live when it starts", () => {
      const session = new FileSessionStore(dir).create("agent");
      const old = new Date(Date.now() - 10_000);
      utimesSync(join(dir, `${session.id}.json`), old, old);

      const store = new FileSessionStore(dir, { idle_ttl_ms: 1_000 });

      expect(store.get(session.id)).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    });

    it("keeps only the most recently written files over the cap when it starts", () => {
      const first = new FileSessionStore(dir);
      const older = first.create("agent");
      const newer = first.create("agent");
      const past = new Date(Date.now() - 5_000);
      utimesSync(join(dir, `${older.id}.json`), past, past);

      const store = new FileSessionStore(dir, { max_sessions: 1 });

      expect(store.get(older.id)).toBeUndefined();
      expect(store.get(newer.id)?.id).toBe(newer.id);
    });
  });

  describe("security", () => {
    it.each(["../escape", "a/b", "..", "", "x".repeat(129), "a.b", "a\0b"])("refuses the id %j", (id) => {
      const store = new FileSessionStore(dir);
      const now = new Date();

      expect(store.get(id)).toBeUndefined();
      expect(() => store.save({ id, agent_name: "a", messages: [], created_at: now, updated_at: now })).toThrow(
        /Invalid session id/,
      );
      expect(existsSync(join(root, "state", "escape.json"))).toBe(false);
    });

    it("ignores a file whose name is not a session id", () => {
      new FileSessionStore(dir);
      writeFileSync(join(dir, "not a session.json"), "{}");

      expect(() => new FileSessionStore(dir)).not.toThrow();
    });
  });

  describe("unreadable files", () => {
    it.each([
      ["is not JSON", "{ nope"],
      ["does not hold a session", JSON.stringify({ id: "s1", messages: "x" })],
      ["holds another id", JSON.stringify({ id: "s2", agent_name: "a", messages: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() })],
    ])("treats a file that %s as no session and leaves it in place", (_why, content) => {
      new FileSessionStore(dir);
      writeFileSync(join(dir, "s1.json"), content);
      const store = new FileSessionStore(dir);

      expect(store.get("s1")).toBeUndefined();
      expect(existsSync(join(dir, "s1.json"))).toBe(true);
      expect(() => store.update("s1", [])).toThrow("Session not found");
    });

    it("keeps working from memory when a write fails", () => {
      const store = new FileSessionStore(dir);
      const session = store.create("agent");
      rmSync(dir, { recursive: true, force: true });

      expect(() => store.update(session.id, HISTORY)).not.toThrow();
      expect(store.get(session.id)?.messages).toEqual(HISTORY);
    });
  });
});
