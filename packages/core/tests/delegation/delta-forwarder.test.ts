import { describe, expect, it, vi } from "vitest";
import type { TuttiEvent } from "@tuttiai/types";

import { forwardDeltas, type DeltaTags } from "../../src/delegation/delta-forwarder.js";
import { EventBus } from "../../src/event-bus.js";
import { SecretsManager } from "../../src/secrets.js";

const ANTHROPIC = `sk-ant-${"a".repeat(24)}`;
const GITHUB = `ghp_${"b".repeat(36)}`;

const tags: DeltaTags = {
  parent_session_id: "parent",
  root_session_id: "root",
  tool_call_id: "call-1",
  from: "Orchestrator",
  to: "coder",
  session_id: "child",
  path: ["call-0", "call-1"],
};

function forward(extra: Partial<DeltaTags> = {}): { bus: EventBus; texts: string[]; deltas: TuttiEvent[]; stop: () => void } {
  const bus = new EventBus();
  const deltas: TuttiEvent[] = [];
  bus.on("delegate:delta", (e) => deltas.push(e));
  const stop = forwardDeltas(bus, { ...tags, ...extra });
  const texts: string[] = [];
  bus.on("delegate:delta", (e) => texts.push(e.text));
  return { bus, texts, deltas, stop };
}

const token = (text: string, session_id = "child"): TuttiEvent => ({ type: "token:stream", agent_name: "coder", session_id, text });

describe("forwardDeltas", () => {
  it("turns the child's tokens into tagged deltas with depth from the path", () => {
    const { bus, deltas } = forward();
    bus.emit(token("hi"));
    expect(deltas).toStrictEqual([{ type: "delegate:delta", ...tags, depth: 2, text: "hi" }]);
  });

  it("ignores tokens from any other session", () => {
    const { bus, texts } = forward();
    bus.emit(token("parent text", "parent"));
    bus.emit(token("sibling text", "other-child"));
    expect(texts).toEqual([]);
  });

  it("forwards nothing once stopped", () => {
    const { bus, texts, stop } = forward();
    stop();
    bus.emit(token("late"));
    expect(texts).toEqual([]);
  });

  it("forwards nothing once the signal has aborted", () => {
    const controller = new AbortController();
    const { bus, texts } = forward({ signal: controller.signal });
    bus.emit(token("before"));
    controller.abort();
    bus.emit(token("after"));
    expect(texts).toEqual(["before"]);
  });

  it("keeps the signal out of the payload", () => {
    const { bus, deltas } = forward({ signal: new AbortController().signal });
    bus.emit(token("x"));
    expect(deltas[0]).not.toHaveProperty("signal");
  });
});

describe("forwardDeltas redaction", () => {
  it("redacts a secret at the start of a chunk", () => {
    const { bus, texts } = forward();
    bus.emit(token(`${ANTHROPIC} is the key`));
    expect(texts).toEqual(["[REDACTED] is the key"]);
  });

  it("redacts a secret at the end of a chunk", () => {
    const { bus, texts } = forward();
    bus.emit(token(`the key is ${GITHUB}`));
    expect(texts).toEqual(["the key is [REDACTED]"]);
  });

  it("redacts several secrets in one chunk", () => {
    const { bus, texts } = forward();
    bus.emit(token(`${ANTHROPIC} and ${GITHUB} and Bearer ${"c".repeat(24)}`));
    expect(texts).toEqual(["[REDACTED] and [REDACTED] and [REDACTED]"]);
    expect(texts.join("")).not.toContain("sk-ant-");
  });

  it("calls SecretsManager.redact on every chunk itself, not only through the bus", () => {
    const spy = vi.spyOn(SecretsManager, "redact");
    try {
      const { bus } = forward();
      bus.emit(token("plain"));
      // The bus redacts whole serialised events; only the forwarder passes the bare chunk.
      expect(spy.mock.calls.filter(([text]) => text === "plain")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("drops a chunk that redacts to nothing", () => {
    const { bus, texts } = forward();
    bus.emit(token(""));
    expect(texts).toEqual([]);
  });
});
