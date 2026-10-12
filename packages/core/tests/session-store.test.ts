import { describe, it, expect } from "vitest";
import { InMemorySessionStore } from "../src/session-store.js";

describe("InMemorySessionStore", () => {
  it("creates a session with a unique id", () => {
    const store = new InMemorySessionStore();
    const session = store.create("test-agent");

    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.agent_name).toBe("test-agent");
    expect(session.messages).toEqual([]);
    expect(session.created_at).toBeInstanceOf(Date);
    expect(session.updated_at).toBeInstanceOf(Date);
  });

  it("creates sessions with unique ids", () => {
    const store = new InMemorySessionStore();
    const s1 = store.create("agent-a");
    const s2 = store.create("agent-b");

    expect(s1.id).not.toBe(s2.id);
  });

  it("retrieves a session by id", () => {
    const store = new InMemorySessionStore();
    const session = store.create("test-agent");

    const retrieved = store.get(session.id);
    expect(retrieved).toBe(session);
  });

  it("returns undefined for unknown session id", () => {
    const store = new InMemorySessionStore();

    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("updates session messages", () => {
    const store = new InMemorySessionStore();
    const session = store.create("test-agent");
    const originalUpdatedAt = session.updated_at;

    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];

    store.update(session.id, messages);

    const updated = store.get(session.id)!;
    expect(updated.messages).toEqual(messages);
    expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it("throws when updating a nonexistent session", () => {
    const store = new InMemorySessionStore();

    expect(() => store.update("nonexistent", [])).toThrow(
      "Session not found: nonexistent",
    );
  });

  it("isolates sessions across different agents", () => {
    const store = new InMemorySessionStore();
    const s1 = store.create("agent-a");
    const s2 = store.create("agent-b");

    store.update(s1.id, [{ role: "user", content: "for a" }]);
    store.update(s2.id, [{ role: "user", content: "for b" }]);

    expect(store.get(s1.id)!.messages[0].content).toBe("for a");
    expect(store.get(s2.id)!.messages[0].content).toBe("for b");
  });
});

describe("InMemorySessionStore bounds", () => {
  it("evicts the least recently used session over the cap", () => {
    const store = new InMemorySessionStore({ max_sessions: 2 });
    const a = store.create("agent");
    const b = store.create("agent");
    store.get(a.id);
    const c = store.create("agent");

    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(a.id)).toBe(a);
    expect(store.get(c.id)).toBe(c);
  });

  it("evicts a session idle past its time to live", () => {
    let now = 0;
    const store = new InMemorySessionStore({ idle_ttl_ms: 1_000, now: () => now });
    const session = store.create("agent");

    now = 1_000;
    expect(store.get(session.id)).toBe(session);
    now = 2_001;
    expect(store.get(session.id)).toBeUndefined();
    expect(() => store.update(session.id, [])).toThrow("Session not found");
  });

  it("keeps a session alive while it is used", () => {
    let now = 0;
    const store = new InMemorySessionStore({ idle_ttl_ms: 1_000, now: () => now });
    const session = store.create("agent");
    for (now = 900; now <= 4_500; now += 900) store.update(session.id, []);

    expect(store.get(session.id)).toBe(session);
  });

  it("sweeps idle sessions when another is created", () => {
    let now = 0;
    const store = new InMemorySessionStore({ idle_ttl_ms: 1_000, now: () => now });
    const old = store.create("agent");
    now = 5_000;
    store.create("agent");
    now = 0;

    expect(store.get(old.id)).toBeUndefined();
  });

  it("defaults to 1000 sessions", () => {
    const store = new InMemorySessionStore();
    const first = store.create("agent");
    for (let i = 0; i < 1_000; i++) store.create("agent");

    expect(store.get(first.id)).toBeUndefined();
  });

  it("counts a saved session against the cap", () => {
    const store = new InMemorySessionStore({ max_sessions: 1 });
    const created = store.create("agent");
    const now = new Date();
    store.save({ id: "restored", agent_name: "agent", messages: [], created_at: now, updated_at: now });

    expect(store.get(created.id)).toBeUndefined();
    expect(store.get("restored")?.id).toBe("restored");
  });
});
