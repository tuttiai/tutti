import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/event-bus.js";
import type { TuttiEvent } from "@tuttiai/types";

describe("EventBus", () => {
  it("delivers events to matching handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("agent:start", handler);
    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });
  });

  it("does not deliver events to non-matching handlers", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("agent:end", handler);
    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple handlers for the same event", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("agent:start", h1);
    bus.on("agent:start", h2);
    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("returns an unsubscribe function from on()", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.on("agent:start", handler);
    unsub();

    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("removes a handler with off()", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("agent:start", handler);
    bus.off("agent:start", handler);

    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("onAny() receives all event types", () => {
    const bus = new EventBus();
    const events: TuttiEvent[] = [];

    bus.onAny((e) => events.push(e));

    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });
    bus.emit({
      type: "agent:end",
      agent_name: "test",
      session_id: "s1",
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("agent:start");
    expect(events[1].type).toBe("agent:end");
  });

  it("onAny() unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.onAny(handler);
    unsub();

    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to both specific and wildcard handlers", () => {
    const bus = new EventBus();
    const specific = vi.fn();
    const wildcard = vi.fn();

    bus.on("agent:start", specific);
    bus.onAny(wildcard);

    bus.emit({
      type: "agent:start",
      agent_name: "test",
      session_id: "s1",
    });

    expect(specific).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });

  it("handles emit with no listeners gracefully", () => {
    const bus = new EventBus();

    expect(() =>
      bus.emit({
        type: "agent:start",
        agent_name: "test",
        session_id: "s1",
      }),
    ).not.toThrow();
  });

  it("off() on unregistered handler is a no-op", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    expect(() => bus.off("agent:start", handler)).not.toThrow();
  });

  // ── Handler isolation (security) ──
  describe("handler isolation", () => {
    it("a throwing handler does not crash emit() or block siblings", () => {
      const bus = new EventBus();
      const bad = vi.fn(() => {
        throw new Error("handler boom");
      });
      const good = vi.fn();

      bus.on("agent:start", bad);
      bus.on("agent:start", good);

      expect(() =>
        bus.emit({
          type: "agent:start",
          agent_name: "test",
          session_id: "s1",
        }),
      ).not.toThrow();

      expect(bad).toHaveBeenCalledOnce();
      // Critical: the sibling handler still fires after the first one threw.
      expect(good).toHaveBeenCalledOnce();
    });

    it("a throwing wildcard handler does not block specific handlers", () => {
      const bus = new EventBus();
      const bad = vi.fn(() => {
        throw new Error("wildcard boom");
      });
      const good = vi.fn();

      bus.onAny(bad);
      bus.on("agent:start", good);

      expect(() =>
        bus.emit({
          type: "agent:start",
          agent_name: "test",
          session_id: "s1",
        }),
      ).not.toThrow();

      expect(good).toHaveBeenCalledOnce();
    });

    it("a rejecting async handler does not produce an unhandled rejection", async () => {
      const bus = new EventBus();
      bus.on("agent:start", () => Promise.reject(new Error("async boom")));

      bus.emit({
        type: "agent:start",
        agent_name: "test",
        session_id: "s1",
      });

      // Yield to let the microtask queue drain; if unhandled, Node would warn.
      await new Promise((r) => setImmediate(r));
      // Reaching here without an unhandled-rejection is the pass condition.
      expect(true).toBe(true);
    });
  });
});
