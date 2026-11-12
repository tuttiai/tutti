import { describe, it, expect } from "vitest";
import type { ToolContext, TuttiEvent } from "@tuttiai/types";

import { EventBus } from "../src/event-bus.js";
import { ToolTimeoutError } from "../src/errors.js";
import { callContext, PROGRESS_MESSAGE_MAX } from "../src/tool-call-context.js";

const base: ToolContext = { session_id: "s-1", agent_name: "assistant" };
const block = { id: "tool-1", name: "build" };

function progressEvents(events: EventBus): TuttiEvent[] {
  const seen: TuttiEvent[] = [];
  events.on("tool:progress", (event) => seen.push(event));
  return seen;
}

describe("callContext", () => {
  it("copies the base context and adds a signal and a reporter", () => {
    const call = callContext(base, { block, events: new EventBus() });

    expect(call.context).toMatchObject(base);
    expect(call.context.signal).toBe(call.controller.signal);
    expect(typeof call.context.report_progress).toBe("function");
    expect(base).toEqual({ session_id: "s-1", agent_name: "assistant" });
  });

  it("gives every call its own signal", () => {
    const events = new EventBus();
    const first = callContext(base, { block, events });
    const second = callContext(base, { block: { id: "tool-2", name: "build" }, events });

    first.controller.abort("one");

    expect(first.context.signal?.aborted).toBe(true);
    expect(second.context.signal?.aborted).toBe(false);
  });

  it("aborts the call's signal when the run aborts", () => {
    const run = new AbortController();
    const call = callContext(base, { block, events: new EventBus(), runSignal: run.signal });

    run.abort("client went away");

    expect(call.context.signal?.aborted).toBe(true);
    expect(call.context.signal?.reason).toBe("client went away");
  });

  it("starts aborted when the run is already aborted", () => {
    const run = new AbortController();
    run.abort("gone");

    const call = callContext(base, { block, events: new EventBus(), runSignal: run.signal });

    expect(call.context.signal?.aborted).toBe(true);
  });

  it("stops following the run's signal once settled", () => {
    const run = new AbortController();
    const call = callContext(base, { block, events: new EventBus(), runSignal: run.signal });

    call.settle();
    run.abort("late");

    expect(call.context.signal?.aborted).toBe(false);
  });

  it("aborts with the timeout error and rethrows it", () => {
    const call = callContext(base, { block, events: new EventBus() });
    const timeout = new ToolTimeoutError("build", 10);

    expect(() => call.fail(timeout)).toThrow(timeout);
    expect(call.context.signal?.reason).toBe(timeout);
  });

  it("rethrows other errors without aborting", () => {
    const call = callContext(base, { block, events: new EventBus() });
    const error = new Error("tool broke");

    expect(() => call.fail(error)).toThrow(error);
    expect(call.context.signal?.aborted).toBe(false);
  });

  describe("report_progress", () => {
    it("emits a tool:progress event tagged with the call", () => {
      const events = new EventBus();
      const seen = progressEvents(events);
      const call = callContext(base, { block, events });

      call.context.report_progress?.({ task_id: "t-1", status: "working", progress: 2, total: 5, source: "mcp-x" });

      expect(seen).toEqual([
        {
          type: "tool:progress",
          agent_name: "assistant",
          session_id: "s-1",
          tool_name: "build",
          tool_call_id: "tool-1",
          task_id: "t-1",
          status: "working",
          progress: 2,
          total: 5,
          source: "mcp-x",
        },
      ]);
    });

    it("redacts the message and caps it", () => {
      const events = new EventBus();
      const seen = progressEvents(events);
      const call = callContext(base, { block, events });
      const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";

      call.context.report_progress?.({ message: `${secret} ${"x".repeat(1000)}` });

      const event = seen[0];
      const message = event?.type === "tool:progress" ? (event.message ?? "") : "";
      expect(message).not.toContain(secret);
      expect(message.length).toBe(PROGRESS_MESSAGE_MAX);
    });

    it("drops a malformed update", () => {
      const events = new EventBus();
      const seen = progressEvents(events);
      const call = callContext(base, { block, events });

      call.context.report_progress?.({ progress: Number.NaN });

      expect(seen).toEqual([]);
    });

    it("emits nothing after the call settles", () => {
      const events = new EventBus();
      const seen = progressEvents(events);
      const call = callContext(base, { block, events });

      call.settle();
      call.context.report_progress?.({ progress: 1 });

      expect(seen).toEqual([]);
    });

    it("emits nothing after the call's signal aborts", () => {
      const events = new EventBus();
      const seen = progressEvents(events);
      const call = callContext(base, { block, events });

      call.controller.abort("stop");
      call.context.report_progress?.({ progress: 1 });

      expect(seen).toEqual([]);
    });
  });
});
