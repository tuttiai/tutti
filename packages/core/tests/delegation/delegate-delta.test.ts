import { describe, expect, it } from "vitest";
import type { ScoreConfig, TuttiEvent } from "@tuttiai/types";

import { AgentRouter } from "../../src/agent-router.js";
import { createScriptedProvider, type ScriptStep } from "../helpers/scripted-provider.js";
import { delegateCall, delegationTrace, deltasOf } from "../helpers/delegation-score.js";

function routerFor(
  scripts: Record<string, ScriptStep[]>,
  streaming = true,
): { router: AgentRouter; events: TuttiEvent[] } {
  const specialist = (id: string): ScoreConfig["agents"][string] => ({
    name: `${id}-name`,
    model: "test-model",
    system_prompt: `MARKER-${id}`,
    voices: [],
    streaming,
  });
  const score: ScoreConfig = {
    provider: createScriptedProvider(scripts),
    entry: "orch",
    agents: {
      orch: { name: "Orchestrator", model: "test-model", system_prompt: "MARKER-orch", voices: [], delegates: ["coder", "writer"] },
      coder: specialist("coder"),
      writer: specialist("writer"),
    },
  };
  const router = new AgentRouter(score);
  const events: TuttiEvent[] = [];
  router.events.onAny((e) => events.push(e));
  return { router, events };
}

const delegateOnce = (agent = "coder"): ScriptStep[] => [
  { tools: [delegateCall("call-1", agent, "write it")] },
  { text: ["done"] },
];

describe("delegate:delta", () => {
  it("streams the specialist's chunks between delegate:start and delegate:end, fully tagged", async () => {
    const { router, events } = routerFor({
      "MARKER-orch": delegateOnce(),
      "MARKER-coder": [{ text: ["Hello ", "from ", "coder"] }],
    });
    const result = await router.run("go");

    expect(delegationTrace(events)).toEqual([
      "delegate:start", "delegate:delta", "delegate:delta", "delegate:delta", "delegate:end",
    ]);
    const deltas = deltasOf(events);
    const childSession = deltas[0]?.session_id;
    expect(childSession).toEqual(expect.any(String));
    expect(childSession).not.toBe(result.session_id);
    for (const delta of deltas) {
      expect(Object.keys(delta).sort()).toEqual([
        "depth", "from", "parent_session_id", "path", "root_session_id", "session_id", "text", "to", "tool_call_id", "type",
      ]);
      expect(delta).toMatchObject({
        parent_session_id: result.session_id,
        root_session_id: result.session_id,
        tool_call_id: "call-1",
        from: "Orchestrator",
        to: "coder",
        session_id: childSession,
        path: ["call-1"],
        depth: 1,
      });
    }
    expect(deltas.map((d) => d.text).join("")).toBe("Hello from coder");
  });

  it("leaves the delegate:start and delegate:end payloads exactly as on main", async () => {
    const { router, events } = routerFor({
      "MARKER-orch": delegateOnce(),
      "MARKER-coder": [{ text: ["a", "b"] }],
    });
    await router.run("go");

    const bracket = events.filter((e) => e.type === "delegate:start" || e.type === "delegate:end");
    expect(bracket).toStrictEqual([
      { type: "delegate:start", from: "Orchestrator", to: "coder", task: "write it" },
      { type: "delegate:end", from: "Orchestrator", to: "coder", output: "ab" },
    ]);
  });

  it("sends no delta for a specialist that does not stream; delegate:end still carries the output", async () => {
    const { router, events } = routerFor(
      { "MARKER-orch": delegateOnce(), "MARKER-coder": [{ text: ["whole ", "answer"] }] },
      false,
    );
    await router.run("go");

    expect(delegationTrace(events)).toEqual(["delegate:start", "delegate:end"]);
    expect(events.find((e) => e.type === "delegate:end")).toMatchObject({ output: "whole answer" });
  });

  it("sends no delta, and never an empty one, when the specialist says nothing", async () => {
    const { router, events } = routerFor({
      "MARKER-orch": delegateOnce(),
      "MARKER-coder": [{ text: ["", ""] }],
    });
    await router.run("go");

    expect(delegationTrace(events)).toEqual(["delegate:start", "delegate:end"]);
  });

  it("forwards 10,000 chunks in order, without dropping any", async () => {
    const chunks = Array.from({ length: 10_000 }, (_, i) => `${i},`);
    const { router, events } = routerFor({
      "MARKER-orch": delegateOnce(),
      "MARKER-coder": [{ text: chunks }],
    });
    await router.run("go");

    const deltas = deltasOf(events);
    expect(deltas).toHaveLength(10_000);
    expect(deltas.map((d) => d.text).join("")).toBe(chunks.join(""));
  });

  it("streams each delta before the specialist finishes, not buffered to the end", async () => {
    const seenBeforeEnd: number[] = [];
    let deltaCount = 0;
    const { router } = routerFor({
      "MARKER-orch": delegateOnce(),
      "MARKER-coder": [{ text: ["a", "b", "c"], onChunk: () => seenBeforeEnd.push(deltaCount) }],
    });
    router.events.on("delegate:delta", () => (deltaCount += 1));
    await router.run("go");

    expect(seenBeforeEnd).toEqual([0, 1, 2]);
  });

  it("keeps parallel delegations apart by tool_call_id", async () => {
    const { router, events } = routerFor({
      "MARKER-orch": [
        { tools: [delegateCall("call-c", "coder"), delegateCall("call-w", "writer")] },
        { text: ["done"] },
      ],
      "MARKER-coder": [{ text: ["c1", "c2"] }],
      "MARKER-writer": [{ text: ["w1", "w2"] }],
    });
    await router.run("go");

    const deltas = deltasOf(events);
    expect(deltas).toHaveLength(4);
    for (const delta of deltas) {
      const expected = delta.tool_call_id === "call-c" ? "coder" : "writer";
      expect(delta.to).toBe(expected);
      expect(delta.text.startsWith(expected[0] ?? "?")).toBe(true);
    }
    expect(new Set(deltas.map((d) => d.session_id)).size).toBe(2);
  });
});
