import { describe, it, expect, vi } from "vitest";
import { AgentRouter } from "../src/agent-router.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";
import type { ScoreConfig, TuttiEvent } from "@tuttiai/types";

function createRoutingScore(
  responses: ReturnType<typeof textResponse>[],
  overrides?: Partial<ScoreConfig>,
): ScoreConfig {
  return {
    provider: createMockProvider(responses),
    agents: {
      orchestrator: {
        name: "Orchestrator",
        role: "orchestrator",
        system_prompt: "You route tasks.",
        voices: [],
        delegates: ["coder", "writer"],
      },
      coder: {
        name: "Coder",
        role: "specialist",
        system_prompt: "You write code.",
        voices: [],
      },
      writer: {
        name: "Writer",
        role: "specialist",
        system_prompt: "You write content.",
        voices: [],
      },
    },
    entry: "orchestrator",
    ...overrides,
  };
}

describe("AgentRouter", () => {
  it("creates successfully with valid config", () => {
    const score = createRoutingScore([textResponse("ok")]);
    expect(() => new AgentRouter(score)).not.toThrow();
  });

  it("throws if entry agent doesn't exist", () => {
    const score = createRoutingScore([textResponse("ok")], {
      entry: "nonexistent",
    });
    expect(() => new AgentRouter(score)).toThrow(
      'Entry agent "nonexistent" not found',
    );
  });

  it("throws if entry agent has no delegates", () => {
    const score: ScoreConfig = {
      provider: createMockProvider([textResponse("ok")]),
      entry: "solo",
      agents: {
        solo: {
          name: "Solo",
          system_prompt: "hi",
          voices: [],
        },
      },
    };
    expect(() => new AgentRouter(score)).toThrow("has no delegates");
  });

  it("throws if a delegate ID doesn't exist", () => {
    const score: ScoreConfig = {
      provider: createMockProvider([textResponse("ok")]),
      entry: "orchestrator",
      agents: {
        orchestrator: {
          name: "Orch",
          system_prompt: "hi",
          voices: [],
          delegates: ["ghost"],
        },
      },
    };
    expect(() => new AgentRouter(score)).toThrow(
      'Delegate "ghost" not found',
    );
  });

  it("runs the entry agent and returns result", async () => {
    const score = createRoutingScore([
      textResponse("Here's the answer."),
    ]);
    const router = new AgentRouter(score);
    const result = await router.run("hello");

    expect(result.output).toBe("Here's the answer.");
    expect(result.turns).toBe(1);
  });

  it("handles delegation: orchestrator delegates to specialist", async () => {
    // Orchestrator calls delegate_to_agent → specialist responds → orchestrator summarizes
    const provider = createMockProvider([
      // Turn 1: orchestrator calls delegate
      toolUseResponse("delegate_to_agent", {
        agent_id: "coder",
        task: "Write a hello world function",
      }),
      // Turn 2 (specialist "coder" run): responds with code
      textResponse("function hello() { return 'world'; }"),
      // Turn 3: orchestrator summarizes
      textResponse("The coder wrote a hello function for you."),
    ]);

    const score = createRoutingScore([], { provider });
    const router = new AgentRouter(score);
    const result = await router.run("write a hello function");

    expect(result.output).toBe(
      "The coder wrote a hello function for you.",
    );
    // Orchestrator: 2 turns (delegate call + final), specialist: 1 turn
    expect(result.turns).toBe(2);
  });

  it("emits delegate:start and delegate:end events", async () => {
    const provider = createMockProvider([
      toolUseResponse("delegate_to_agent", {
        agent_id: "writer",
        task: "Write a poem",
      }),
      textResponse("Roses are red..."),
      textResponse("Here is the poem."),
    ]);

    const score = createRoutingScore([], { provider });
    const router = new AgentRouter(score);

    const delegateEvents: TuttiEvent[] = [];
    router.events.on("delegate:start", (e) => delegateEvents.push(e));
    router.events.on("delegate:end", (e) => delegateEvents.push(e));

    await router.run("write a poem");

    expect(delegateEvents).toHaveLength(2);
    expect(delegateEvents[0].type).toBe("delegate:start");
    expect((delegateEvents[0] as { to: string }).to).toBe("writer");
    expect(delegateEvents[1].type).toBe("delegate:end");
  });

  it("enhances the orchestrator system prompt with delegate info", async () => {
    const provider = createMockProvider([textResponse("ok")]);
    const score = createRoutingScore([], { provider });
    const router = new AgentRouter(score);

    await router.run("test");

    // The provider.chat should have been called with an enhanced system prompt
    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(chatCall.system).toContain("delegate_to_agent");
    expect(chatCall.system).toContain('"coder"');
    expect(chatCall.system).toContain('"writer"');
  });

  it("injects delegate_to_agent as a tool in the LLM request", async () => {
    const provider = createMockProvider([textResponse("ok")]);
    const score = createRoutingScore([], { provider });
    const router = new AgentRouter(score);

    await router.run("test");

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const toolNames = chatCall.tools?.map(
      (t: { name: string }) => t.name,
    );
    expect(toolNames).toContain("delegate_to_agent");
  });

  it("returns error if delegation fails", async () => {
    // Provider: orchestrator delegates, then specialist throws, then orchestrator handles
    const callCount = { n: 0 };
    const provider = {
      chat: vi.fn(async () => {
        callCount.n++;
        if (callCount.n === 1) {
          return toolUseResponse("delegate_to_agent", {
            agent_id: "coder",
            task: "do something",
          });
        }
        // Specialist call fails
        if (callCount.n === 2) {
          throw new Error("LLM exploded");
        }
        // Orchestrator handles the error
        return textResponse("Something went wrong.");
      }),
    };

    const score = createRoutingScore([], { provider });
    const router = new AgentRouter(score);
    const result = await router.run("test");

    // The delegation error should be returned as a tool result,
    // and the orchestrator continues
    expect(result.output).toBe("Something went wrong.");
  });

  it("exposes events from the underlying runtime", async () => {
    const score = createRoutingScore([textResponse("ok")]);
    const router = new AgentRouter(score);

    const events: string[] = [];
    router.events.onAny((e) => events.push(e.type));

    await router.run("test");

    expect(events).toContain("agent:start");
    expect(events).toContain("agent:end");
  });

  it("defaults entry to 'orchestrator' when not specified", async () => {
    const provider = createMockProvider([textResponse("routed")]);
    const score: ScoreConfig = {
      provider,
      agents: {
        orchestrator: {
          name: "Orch",
          system_prompt: "route",
          voices: [],
          delegates: ["helper"],
        },
        helper: {
          name: "Helper",
          system_prompt: "help",
          voices: [],
        },
      },
      // no entry field
    };
    const router = new AgentRouter(score);
    const result = await router.run("test");

    expect(result.output).toBe("routed");
  });
});
