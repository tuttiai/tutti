/**
 * Unit tests for {@link movedOn} and {@link refuseIfMovedOn}: a durable run
 * notices that another run finished its session while it was held (#133).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Session, SessionStore } from "@tuttiai/types";

import { TuttiError } from "../../src/errors.js";
import { movedOn, refuseIfMovedOn, sessionMark } from "../../src/runner/session-moved-on.js";
import { InMemorySessionStore } from "../../src/session-store.js";

const TURN: ChatMessage[] = [
  { role: "user", content: "clean up" },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

let clock = 0;
const bounds = { idle_ttl_ms: 10, now: (): number => clock };

beforeEach(() => {
  clock = 1_000;
  vi.useFakeTimers({ now: new Date("2026-11-18T21:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("movedOn", () => {
  it("is false for a session nobody else has written", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    const mark = sessionMark(session);

    expect(await movedOn(store, session.id, mark)).toBe(false);
  });

  it("is true when another run's history landed, even with the clock frozen", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    const mark = sessionMark(session);

    store.update(session.id, TURN);

    expect(store.get(session.id)?.updated_at.getTime()).toBe(mark.updated_ms);
    expect(await movedOn(store, session.id, mark)).toBe(true);
  });

  it("is true when the session was rewritten at the same length", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    store.update(session.id, TURN);
    const mark = sessionMark(session);

    vi.advanceTimersByTime(1_000);
    store.update(session.id, [...TURN]);

    expect(await movedOn(store, session.id, mark)).toBe(true);
  });

  it("is false for a session the store evicted, so the write-back can restore it", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    const mark = sessionMark(session);
    clock += 11;

    expect(await movedOn(store, session.id, mark)).toBe(false);
  });

  it("loads the session when get misses, as a store backed by another process does", async () => {
    const started: Session = { id: "s1", agent_name: "worker", messages: [], created_at: new Date(), updated_at: new Date() };
    const mark = sessionMark(started);
    const load = vi.fn((): Promise<Session> => Promise.resolve({ ...started, messages: TURN }));
    const store: SessionStore = { create: vi.fn(), get: vi.fn((): Session | undefined => undefined), update: vi.fn(), load };

    expect(await movedOn(store, "s1", mark)).toBe(true);
    expect(load).toHaveBeenCalledWith("s1");
  });

  it("does not load when get already holds the session", async () => {
    const started: Session = { id: "s1", agent_name: "worker", messages: [], created_at: new Date(), updated_at: new Date() };
    const load = vi.fn((): Promise<Session | undefined> => Promise.resolve(undefined));
    const store: SessionStore = { create: vi.fn(), get: vi.fn(() => started), update: vi.fn(), load };

    expect(await movedOn(store, "s1", sessionMark(started))).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("refuseIfMovedOn", () => {
  it("lets the run write back when the session has not moved on", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");

    await expect(refuseIfMovedOn(store, session.id, sessionMark(session))).resolves.toBeUndefined();
  });

  it("rejects with RUN_SUPERSEDED, naming only the session, when another run finished it", async () => {
    const store = new InMemorySessionStore(bounds);
    const session = store.create("worker");
    const mark = sessionMark(session);
    store.update(session.id, TURN);

    const err: unknown = await refuseIfMovedOn(store, session.id, mark).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TuttiError);
    expect(err).toMatchObject({ code: "RUN_SUPERSEDED", context: { session_id: session.id } });
    expect(String(err)).not.toContain("clean up");
  });
});
