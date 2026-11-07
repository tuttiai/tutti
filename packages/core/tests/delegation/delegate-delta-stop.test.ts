import { describe, expect, it, vi } from "vitest";
import type { TuttiEvent } from "@tuttiai/types";

import { RunAbortedError } from "../../src/errors.js";
import type { TuttiRuntime } from "../../src/runtime.js";
import { createScriptedProvider, type ScriptStep } from "../helpers/scripted-provider.js";
import { delegateCall, delegationRuntime, delegationTrace, deltasOf } from "../helpers/delegation-score.js";

const agents = [{ id: "orch", delegates: ["a"], streaming: false }, { id: "a", delegates: ["b"] }, { id: "b" }];

/** Counts token:stream listeners still attached, by wrapping the unsubscribe `on` returns. */
function trackStreamListeners(runtime: TuttiRuntime): { live: () => number; peak: () => number } {
  const bus = runtime.events;
  const original = bus.on.bind(bus);
  let live = 0;
  let peak = 0;
  const tracked = (type: string, handler: (event: never) => void): (() => void) => {
    // Safe: forwards exactly the arguments `on` was called with.
    const off = (original as (t: string, h: (event: never) => void) => () => void)(type, handler);
    if (type !== "token:stream") return off;
    live += 1;
    peak = Math.max(peak, live);
    let done = false;
    return () => {
      if (!done) live -= 1;
      done = true;
      off();
    };
  };
  // Safe: `tracked` has the runtime shape of `on`; only its generic signature differs.
  vi.spyOn(bus, "on").mockImplementation(tracked as typeof bus.on);
  return { live: () => live, peak: () => peak };
}

function setUp(
  a: ScriptStep[],
  b: ScriptStep[] = [],
): { runtime: TuttiRuntime; events: TuttiEvent[]; live: () => number; peak: () => number } {
  const provider = createScriptedProvider({
    "MARKER-orch": [{ tools: [delegateCall("call-top", "a")] }, { text: ["done"] }],
    "MARKER-a": a,
    "MARKER-b": b,
  });
  const { runtime, events } = delegationRuntime(provider, agents);
  return { runtime, events, ...trackStreamListeners(runtime) };
}

function expectNoDeltaAfter(events: TuttiEvent[], index: number): void {
  expect(index).toBeGreaterThanOrEqual(0);
  expect(events.slice(index + 1).filter((e) => e.type === "delegate:delta")).toEqual([]);
}

describe("delegate:delta when a specialist fails", () => {
  it("keeps what streamed, sends nothing after the error result and no delegate:end", async () => {
    const { runtime, events, live } = setUp([{ text: ["x1", "x2", "x3"], failAfter: { chunks: 2, message: "boom" } }]);
    await runtime.run("orch", "go");

    expect(deltasOf(events).map((d) => d.text)).toEqual(["x1", "x2"]);
    expect(delegationTrace(events)).not.toContain("delegate:end");
    const toolEnd = events.findIndex((e) => e.type === "tool:end" && e.tool_name === "delegate_to_agent");
    const result = events[toolEnd];
    expect(result?.type === "tool:end" ? result.result : undefined).toMatchObject({ is_error: true });
    expect(result?.type === "tool:end" ? result.result.content : "").toContain('Delegation to "a" failed:');
    expectNoDeltaAfter(events, toolEnd);
    expect(live()).toBe(0);
  });

  it("stops a failed grandchild's deltas while its parent carries on", async () => {
    const { runtime, events, live } = setUp(
      [{ tools: [delegateCall("call-a", "b")] }, { text: ["a-after"] }],
      [{ text: ["b1", "b2"], failAfter: { chunks: 1, message: "deep boom" } }],
    );
    await runtime.run("orch", "go");

    const deltas = deltasOf(events);
    expect(deltas.map((d) => `${d.depth}:${d.text}`)).toEqual(["2:b1", "1:a-after"]);
    const bEnd = events.findIndex((e) => e.type === "tool:end" && e.agent_name === "a-name");
    expect(events.slice(bEnd + 1).some((e) => e.type === "delegate:delta" && e.depth === 2)).toBe(false);
    expect(live()).toBe(0);
  });
});

describe("delegate:delta when the parent run is aborted", () => {
  async function abortedRun(abortAt: (controller: AbortController) => ScriptStep): Promise<{ events: TuttiEvent[]; live: () => number; abortIndex: number }> {
    const controller = new AbortController();
    let abortIndex = -1;
    const { runtime, events, live } = setUp([abortAt(controller)]);
    controller.signal.addEventListener("abort", () => (abortIndex = events.length - 1));
    await expect(runtime.run("orch", "go", undefined, { signal: controller.signal })).rejects.toBeInstanceOf(RunAbortedError);
    return { events, live, abortIndex };
  }

  it("sends no delta when aborted before the first chunk", async () => {
    const { events, live } = await abortedRun((c) => ({ text: ["p", "q"], onChunk: (i) => i === 0 && c.abort("gone") }));
    expect(deltasOf(events)).toEqual([]);
    expect(delegationTrace(events)).toEqual(["delegate:start"]);
    expect(live()).toBe(0);
  });

  it("stops at once when aborted mid-stream", async () => {
    const { events, live, abortIndex } = await abortedRun((c) => ({
      text: ["p", "q", "r", "s"],
      onChunk: (i) => i === 2 && c.abort("gone"),
    }));
    expect(deltasOf(events).map((d) => d.text)).toEqual(["p", "q"]);
    expectNoDeltaAfter(events, abortIndex);
    expect(delegationTrace(events)).not.toContain("delegate:end");
    expect(live()).toBe(0);
  });

  it("sends no delegate:end when aborted after the last chunk", async () => {
    const { events, live, abortIndex } = await abortedRun((c) => ({ text: ["p", "q"], onEnd: () => c.abort("gone") }));
    expect(deltasOf(events).map((d) => d.text)).toEqual(["p", "q"]);
    expectNoDeltaAfter(events, abortIndex);
    expect(delegationTrace(events)).toEqual(["delegate:start", "delegate:delta", "delegate:delta"]);
    expect(live()).toBe(0);
  });

  it("stops both levels when aborted inside a grandchild", async () => {
    const controller = new AbortController();
    const { runtime, events, live } = setUp(
      [{ tools: [delegateCall("call-a", "b")] }, { text: ["never"] }],
      [{ text: ["b1", "b2"], onChunk: (i) => i === 1 && controller.abort("gone") }],
    );
    await expect(runtime.run("orch", "go", undefined, { signal: controller.signal })).rejects.toBeInstanceOf(RunAbortedError);
    expect(deltasOf(events).map((d) => `${d.depth}:${d.text}`)).toEqual(["2:b1"]);
    expect(delegationTrace(events)).toEqual(["delegate:start", "delegate:start", "delegate:delta"]);
    expect(live()).toBe(0);
  });
});

describe("delegate:delta listeners", () => {
  it("forwards nothing from a finished specialist's session afterwards", async () => {
    const { runtime, events, live, peak } = setUp([{ text: ["only"] }]);
    await runtime.run("orch", "go");
    const child = deltasOf(events)[0]?.session_id ?? "";
    const before = deltasOf(events).length;

    runtime.events.emit({ type: "token:stream", agent_name: "a-name", session_id: child, text: "late" });

    expect(deltasOf(events)).toHaveLength(before);
    expect(peak()).toBe(1);
    expect(live()).toBe(0);
  });
});
