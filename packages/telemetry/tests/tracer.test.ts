import { describe, it, expect, beforeEach, vi } from "vitest";

import { DEFAULT_MAX_SPANS, TuttiTracer } from "../src/tracer.js";
import type { TuttiSpan } from "../src/types.js";

describe("TuttiTracer", () => {
  let tracer: TuttiTracer;

  beforeEach(() => {
    tracer = new TuttiTracer();
  });

  describe("constructor", () => {
    it("defaults to a 1000-span ring buffer", () => {
      expect(DEFAULT_MAX_SPANS).toBe(1000);
    });

    it("rejects non-positive max_spans", () => {
      expect(() => new TuttiTracer({ max_spans: 0 })).toThrow(
        /max_spans must be a positive integer/,
      );
      expect(() => new TuttiTracer({ max_spans: -1 })).toThrow();
      expect(() => new TuttiTracer({ max_spans: 1.5 })).toThrow();
    });
  });

  describe("startSpan", () => {
    it("creates a running span with a fresh trace_id and span_id", () => {
      const span = tracer.startSpan("agent.run", "agent", { agent_id: "a1" });

      expect(span.name).toBe("agent.run");
      expect(span.kind).toBe("agent");
      expect(span.status).toBe("running");
      expect(span.span_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(span.trace_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(span.parent_span_id).toBeUndefined();
      expect(span.started_at).toBeInstanceOf(Date);
      expect(span.ended_at).toBeUndefined();
      expect(span.duration_ms).toBeUndefined();
      expect(span.attributes).toEqual({ agent_id: "a1" });
    });

    it("generates distinct ids on every call", () => {
      const a = tracer.startSpan("x", "tool");
      const b = tracer.startSpan("x", "tool");

      expect(a.span_id).not.toBe(b.span_id);
      // Independent root spans must not share a trace.
      expect(a.trace_id).not.toBe(b.trace_id);
    });

    it("inherits trace_id from a known parent and records parent_span_id", () => {
      const root = tracer.startSpan("agent.run", "agent");
      const child = tracer.startSpan("tool.call", "tool", { tool_name: "read_file" }, root.span_id);

      expect(child.parent_span_id).toBe(root.span_id);
      expect(child.trace_id).toBe(root.trace_id);
    });

    it("records parent_span_id even when the parent is unknown, with a fresh trace_id", () => {
      const orphan = tracer.startSpan("tool.call", "tool", {}, "not-a-real-id");

      expect(orphan.parent_span_id).toBe("not-a-real-id");
      expect(orphan.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("copies the attributes object so later mutation does not leak in", () => {
      const attrs = { agent_id: "a1" };
      const span = tracer.startSpan("agent.run", "agent", attrs);

      attrs.agent_id = "mutated";
      expect(span.attributes.agent_id).toBe("a1");
    });
  });

  describe("endSpan", () => {
    it("sets status, ended_at, and computes duration_ms", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const span = tracer.startSpan("tool.call", "tool");
      vi.advanceTimersByTime(250);
      tracer.endSpan(span.span_id, "ok");

      expect(span.status).toBe("ok");
      expect(span.ended_at).toEqual(new Date("2026-01-01T00:00:00.250Z"));
      expect(span.duration_ms).toBe(250);

      vi.useRealTimers();
    });

    it("merges extra_attributes over the existing attributes", () => {
      const span = tracer.startSpan("llm.completion", "llm", { model: "claude-opus-4-6" });
      tracer.endSpan(span.span_id, "ok", {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });

      expect(span.attributes).toEqual({
        model: "claude-opus-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
    });

    it("attaches an error payload when status is 'error'", () => {
      const span = tracer.startSpan("tool.call", "tool");
      tracer.endSpan(span.span_id, "error", undefined, {
        message: "tool blew up",
        stack: "at Foo.bar",
      });

      expect(span.status).toBe("error");
      expect(span.error).toEqual({ message: "tool blew up", stack: "at Foo.bar" });
    });

    it("throws when the span_id is unknown", () => {
      expect(() => tracer.endSpan("nope", "ok")).toThrow(/unknown span_id/);
    });
  });

  describe("getTrace", () => {
    it("returns spans for one trace in insertion order, ignoring others", () => {
      const root = tracer.startSpan("agent.run", "agent");
      const childA = tracer.startSpan("tool.call", "tool", {}, root.span_id);
      const otherRoot = tracer.startSpan("agent.run", "agent");
      const childB = tracer.startSpan("llm.completion", "llm", {}, root.span_id);

      const trace = tracer.getTrace(root.trace_id);

      expect(trace.map((s) => s.span_id)).toEqual([root.span_id, childA.span_id, childB.span_id]);
      expect(trace).not.toContain(otherRoot);
    });

    it("returns an empty array for an unknown trace_id", () => {
      expect(tracer.getTrace("missing")).toEqual([]);
    });
  });

  describe("subscribe", () => {
    it("fires the callback on startSpan and endSpan with the same span instance", () => {
      const events: Array<{ status: TuttiSpan["status"]; id: string }> = [];
      tracer.subscribe((s) => events.push({ status: s.status, id: s.span_id }));

      const span = tracer.startSpan("tool.call", "tool");
      tracer.endSpan(span.span_id, "ok");

      expect(events).toEqual([
        { status: "running", id: span.span_id },
        { status: "ok", id: span.span_id },
      ]);
    });

    it("delivers spans to multiple subscribers", () => {
      const a = vi.fn();
      const b = vi.fn();
      tracer.subscribe(a);
      tracer.subscribe(b);

      tracer.startSpan("tool.call", "tool");

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("returns an unsubscribe function that detaches the listener", () => {
      const cb = vi.fn();
      const unsubscribe = tracer.subscribe(cb);

      tracer.startSpan("a", "tool");
      expect(cb).toHaveBeenCalledTimes(1);

      unsubscribe();
      tracer.startSpan("b", "tool");
      expect(cb).toHaveBeenCalledTimes(1);

      // unsubscribe is idempotent
      expect(() => unsubscribe()).not.toThrow();
    });

    it("isolates a throwing subscriber from other subscribers and from the tracer", () => {
      const good = vi.fn();
      tracer.subscribe(() => {
        throw new Error("boom");
      });
      tracer.subscribe(good);

      expect(() => tracer.startSpan("tool.call", "tool")).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });
  });

  describe("ring buffer", () => {
    it("evicts the oldest span once max_spans is exceeded", () => {
      const small = new TuttiTracer({ max_spans: 3 });
      const a = small.startSpan("a", "tool");
      const b = small.startSpan("b", "tool");
      small.startSpan("c", "tool");
      const d = small.startSpan("d", "tool");

      // `a` should have been evicted; subsequent endSpan must throw.
      expect(() => small.endSpan(a.span_id, "ok")).toThrow(/unknown span_id/);
      // `b`, `c`, `d` are still tracked.
      expect(() => small.endSpan(b.span_id, "ok")).not.toThrow();
      expect(() => small.endSpan(d.span_id, "ok")).not.toThrow();
    });

    it("excludes evicted spans from getTrace", () => {
      const small = new TuttiTracer({ max_spans: 2 });
      const root = small.startSpan("agent.run", "agent");
      const child1 = small.startSpan("t1", "tool", {}, root.span_id);
      // adding a third span evicts `root`
      small.startSpan("t2", "tool", {}, root.span_id);

      const trace = small.getTrace(root.trace_id);
      expect(trace.map((s) => s.name)).toEqual(["t1", "t2"]);
      expect(trace).not.toContain(root);
      expect(trace[0]?.span_id).toBe(child1.span_id);
    });
  });
});
