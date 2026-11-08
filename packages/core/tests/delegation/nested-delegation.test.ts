import { describe, expect, it } from "vitest";
import type { ChatRequest, ScoreConfig, TuttiEvent } from "@tuttiai/types";

import { AgentRouter } from "../../src/agent-router.js";
import { validateScore } from "../../src/score-schema.js";
import { createMockProvider, textResponse, toolUseResponse } from "../helpers/mock-provider.js";

type Responses = Parameters<typeof createMockProvider>[0];

function score(responses: Responses, extra: Partial<ScoreConfig> = {}, aDelegates: string[] = ["b"]): ScoreConfig {
  return {
    provider: createMockProvider(responses),
    entry: "orch",
    agents: {
      orch: { name: "Orchestrator", system_prompt: "You route.", voices: [], delegates: ["a"] },
      a: { name: "Agent A", system_prompt: "You are A.", voices: [], delegates: aDelegates },
      b: { name: "Agent B", system_prompt: "You are B.", voices: [] },
    },
    ...extra,
  };
}

const twoLevels: Responses = [
  toolUseResponse("delegate_to_agent", { agent_id: "a", task: "ask b" }, "call-top"),
  toolUseResponse("delegate_to_agent", { agent_id: "b", task: "answer" }, "call-a"),
  textResponse("from b"),
  textResponse("from a"),
  textResponse("final"),
];

function requestOf(config: ScoreConfig, index: number): ChatRequest | undefined {
  // Safe: the provider is the mock built in score(), whose chat is a vitest spy.
  const chat = (config.provider as ReturnType<typeof createMockProvider>).chat;
  return chat.mock.calls[index]?.[0] as ChatRequest | undefined;
}

const toolNames = (request: ChatRequest | undefined): string[] => (request?.tools ?? []).map((t) => t.name);

describe("AgentRouter nested_delegation", () => {
  it("off by default: a specialist's delegates[] is ignored, as before", async () => {
    const config = score([toolUseResponse("delegate_to_agent", { agent_id: "a", task: "t" }, "call-top"), textResponse("from a"), textResponse("final")]);
    const router = new AgentRouter(config);
    await router.run("go");

    const aRequest = requestOf(config, 1);
    expect(toolNames(aRequest)).not.toContain("delegate_to_agent");
    expect(aRequest?.system).toBe("You are A.");
  });

  it("off: does not check a specialist's delegates[] at construction", () => {
    expect(() => new AgentRouter(score([], {}, ["ghost"]))).not.toThrow();
    expect(() => new AgentRouter(score([], { nested_delegation: false }, ["orch"]))).not.toThrow();
  });

  it("on: a specialist delegates in turn, two levels deep", async () => {
    const config = score(twoLevels, { nested_delegation: true });
    const router = new AgentRouter(config);
    const delegations: TuttiEvent[] = [];
    router.events.on("delegate:start", (e) => delegations.push(e));
    router.events.on("delegate:end", (e) => delegations.push(e));

    const result = await router.run("go");

    expect(result.output).toBe("final");
    expect(delegations).toStrictEqual([
      { type: "delegate:start", from: "Orchestrator", to: "a", task: "ask b" },
      { type: "delegate:start", from: "Agent A", to: "b", task: "answer" },
      { type: "delegate:end", from: "Agent A", to: "b", output: "from b" },
      { type: "delegate:end", from: "Orchestrator", to: "a", output: "from a" },
    ]);
    expect(toolNames(requestOf(config, 1))).toContain("delegate_to_agent");
    expect(requestOf(config, 1)?.system).toContain('"b": Agent B');
    expect(toolNames(requestOf(config, 2))).not.toContain("delegate_to_agent");
  });

  it("on: leaves the entry agent's prompt and tools exactly as with the option off", async () => {
    const on = score([textResponse("hi")], { nested_delegation: true });
    const off = score([textResponse("hi")]);
    await new AgentRouter(on).run("go");
    await new AgentRouter(off).run("go");

    expect(requestOf(on, 0)?.system).toBe(requestOf(off, 0)?.system);
    expect(requestOf(on, 0)?.tools).toEqual(requestOf(off, 0)?.tools);
  });

  it("on: refuses an unknown delegate id at construction", () => {
    expect(() => new AgentRouter(score([], { nested_delegation: true }, ["ghost"]))).toThrow(
      'agent "a" delegates to unknown agent "ghost"',
    );
  });

  it("on: refuses a cycle at construction", () => {
    expect(() => new AgentRouter(score([], { nested_delegation: true }, ["orch"]))).toThrow(
      "delegation cycle orch -> a -> orch",
    );
  });
});

describe("score schema nested_delegation", () => {
  it("accepts a boolean", () => {
    expect(() => validateScore(score([], { nested_delegation: true }))).not.toThrow();
  });

  it("refuses anything else", () => {
    const bad = { ...score([]), nested_delegation: "yes" };
    expect(() => validateScore(bad)).toThrow(/nested_delegation/);
  });
});
