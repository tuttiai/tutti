import { describe, expect, it } from "vitest";

import { buildDelegateTool, delegateParameters } from "../../src/delegation/delegate-tool.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { delegationRuntime, delegationTrace } from "../helpers/delegation-score.js";

const context = { session_id: "s", agent_name: "caller" };

describe("delegateParameters", () => {
  it("accepts a listed specialist and a task", () => {
    expect(delegateParameters(["a", "b"]).parse({ agent_id: "b", task: "t" })).toEqual({ agent_id: "b", task: "t" });
  });

  it("refuses a specialist that is not listed", () => {
    expect(delegateParameters(["a"]).safeParse({ agent_id: "admin", task: "t" }).success).toBe(false);
  });

  it("refuses input without a task", () => {
    expect(delegateParameters(["a"]).safeParse({ agent_id: "a" }).success).toBe(false);
  });
});

describe("buildDelegateTool outside a runner's tool call", () => {
  it("runs the specialist as before, with start and end but no deltas", async () => {
    const provider = createScriptedProvider({ "MARKER-a": [{ text: ["x", "y"] }] });
    const { runtime, events } = delegationRuntime(provider, [{ id: "a" }]);
    const tool = buildDelegateTool({ runtime: () => runtime, score: runtime.score, callerId: "caller", callerName: "Caller" }, ["a"]);

    const result = await tool.execute({ agent_id: "a", task: "t" }, context);

    expect(result).toEqual({ content: "xy" });
    expect(delegationTrace(events)).toEqual(["delegate:start", "delegate:end"]);
  });

  it("returns an error result with the reason when the specialist fails", async () => {
    const provider = createScriptedProvider({});
    const { runtime } = delegationRuntime(provider, [{ id: "a" }]);
    const tool = buildDelegateTool({ runtime: () => runtime, score: runtime.score, callerId: "caller", callerName: "Caller" }, ["a"]);

    const result = await tool.execute({ agent_id: "a", task: "t" }, context);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Delegation to "a" failed:');
  });

  it("says so when the specialist returns no output", async () => {
    const provider = createScriptedProvider({ "MARKER-a": [{ text: [] }] });
    const { runtime } = delegationRuntime(provider, [{ id: "a" }]);
    const tool = buildDelegateTool({ runtime: () => runtime, score: runtime.score, callerId: "caller", callerName: "Caller" }, ["a"]);

    expect(await tool.execute({ agent_id: "a", task: "t" }, context)).toEqual({ content: "(specialist returned no output)" });
  });
});
