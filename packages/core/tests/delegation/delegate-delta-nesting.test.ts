import { describe, expect, it } from "vitest";

import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { delegateCall, delegationRuntime, deltasOf } from "../helpers/delegation-score.js";

const agents = [
  { id: "orch", delegates: ["a"], streaming: false },
  { id: "a", delegates: ["b", "orch"] },
  { id: "b" },
];

describe("delegate:delta, two levels deep", () => {
  it("tags a grandchild's deltas with depth 2 and the full path, on the top-level stream", async () => {
    const provider = createScriptedProvider({
      "MARKER-orch": [{ tools: [delegateCall("call-top", "a")] }, { text: ["all done"] }],
      "MARKER-a": [{ tools: [delegateCall("call-a", "b")] }, { text: ["a1", "a2"] }],
      "MARKER-b": [{ text: ["b1", "b2"] }],
    });
    const { runtime, events } = delegationRuntime(provider, agents);
    const result = await runtime.run("orch", "go");

    const deltas = deltasOf(events);
    const fromB = deltas.filter((d) => d.to === "b");
    const fromA = deltas.filter((d) => d.to === "a");
    expect(fromB.map((d) => d.text)).toEqual(["b1", "b2"]);
    expect(fromA.map((d) => d.text)).toEqual(["a1", "a2"]);

    const aSession = fromA[0]?.session_id;
    for (const d of fromA) {
      expect(d).toMatchObject({
        depth: 1, path: ["call-top"], tool_call_id: "call-top", from: "orch-name",
        parent_session_id: result.session_id, root_session_id: result.session_id,
      });
    }
    for (const d of fromB) {
      expect(d).toMatchObject({
        depth: 2, path: ["call-top", "call-a"], tool_call_id: "call-a", from: "a-name",
        parent_session_id: aSession, root_session_id: result.session_id,
      });
      expect(d.session_id).not.toBe(aSession);
    }
  });

  it("brackets each level with its own start and end, and sends each delta once", async () => {
    const provider = createScriptedProvider({
      "MARKER-orch": [{ tools: [delegateCall("call-top", "a")] }, { text: ["done"] }],
      "MARKER-a": [{ tools: [delegateCall("call-a", "b")] }, { text: ["a1"] }],
      "MARKER-b": [{ text: ["b1"] }],
    });
    const { runtime, events } = delegationRuntime(provider, agents);
    await runtime.run("orch", "go");

    const trace = events
      .filter((e) => e.type.startsWith("delegate:"))
      .map((e) => (e.type === "delegate:delta" ? `delta:${e.text}` : `${e.type}:${"to" in e ? e.to : ""}`));
    expect(trace).toEqual([
      "delegate:start:a",
      "delegate:start:b",
      "delta:b1",
      "delegate:end:b",
      "delta:a1",
      "delegate:end:a",
    ]);
  });

  it("refuses a delegation back up the chain instead of looping", async () => {
    const provider = createScriptedProvider({
      "MARKER-orch": [{ tools: [delegateCall("call-top", "a")] }, { text: ["done"] }],
      "MARKER-a": [{ tools: [delegateCall("call-loop", "orch")] }, { text: ["gave up"] }],
    });
    const { runtime, events } = delegationRuntime(provider, agents);
    await runtime.run("orch", "go");

    const refused = events.find((e) => e.type === "tool:end" && e.agent_name === "a-name");
    expect(refused).toMatchObject({ result: { is_error: true } });
    expect(refused?.type === "tool:end" ? refused.result.content : "").toContain("would loop");
    expect(events.filter((e) => e.type === "delegate:start").map((e) => ("to" in e ? e.to : ""))).toEqual(["a"]);
  });
});
