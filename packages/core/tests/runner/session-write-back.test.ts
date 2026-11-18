/**
 * Unit tests for {@link writeBack}: a run's history goes back to its session,
 * which is restored under its id when the store evicted it while the run waited.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Session, SessionStore } from "@tuttiai/types";

import { FileSessionStore } from "../../src/file-session-store.js";
import { writeBack } from "../../src/runner/session-write-back.js";
import { InMemorySessionStore } from "../../src/session-store.js";

const HISTORY: ChatMessage[] = [
  { role: "user", content: "clean up" },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

let clock = 0;
const bounds = { idle_ttl_ms: 10, now: (): number => clock };

beforeEach(() => {
  clock = 1_000;
});

describe("writeBack", () => {
  it("updates a session that is still live", () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    const update = vi.spyOn(store, "update");
    const save = vi.spyOn(store, "save");
    clock += 10;

    writeBack(store, session, HISTORY);

    expect(update).toHaveBeenCalledWith(session.id, HISTORY);
    expect(save).not.toHaveBeenCalled();
    expect(store.get(session.id)?.messages).toEqual(HISTORY);
  });

  it("restores an in-memory session evicted while the run waited", () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    clock += 11;

    writeBack(store, session, HISTORY);

    const restored = store.get(session.id);
    expect(restored).toMatchObject({ id: session.id, agent_name: "worker", messages: HISTORY });
    expect(restored?.created_at).toEqual(session.created_at);
  });

  it("throws, as before, for a custom store that lost the session", () => {
    const update = vi.fn((id: string): void => {
      throw new Error(`Session not found: ${id}`);
    });
    const get = vi.fn((): Session | undefined => undefined);
    const store: SessionStore = { create: vi.fn(), get, update };
    const at = new Date();
    const session: Session = { id: "gone", agent_name: "worker", messages: [], created_at: at, updated_at: at };

    expect(() => writeBack(store, session, HISTORY)).toThrow("Session not found: gone");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("writeBack with a FileSessionStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-write-back-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores the session and its file after eviction deleted them", () => {
    const store = new FileSessionStore(dir, bounds);
    const session = store.create("worker");
    const file = join(dir, `${session.id}.json`);
    clock += 11;
    expect(store.get(session.id)).toBeUndefined();
    expect(existsSync(file)).toBe(false);

    writeBack(store, session, HISTORY);

    expect(existsSync(file)).toBe(true);
    expect(new FileSessionStore(dir, bounds).get(session.id)?.messages).toEqual(HISTORY);
  });
});
