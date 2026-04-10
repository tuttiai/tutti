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
