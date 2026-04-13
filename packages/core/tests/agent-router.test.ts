import { describe, it, expect, vi } from "vitest";
import { AgentRouter } from "../src/agent-router.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "./helpers/mock-provider.js";
import type {
  ChatRequest,
  LLMProvider,
  ScoreConfig,
  StreamChunk,
  TuttiEvent,
} from "@tuttiai/types";

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

  // ==========================================================================
  // Parallel execution
  // ==========================================================================

  /** Provider whose chat() delays, and can be steered per-agent via system prompt. */
  function createDelayedProvider(
    routes: { match: string; behavior: "ok" | "fail" | "slow" }[],
    opts: { baseDelayMs?: number; slowDelayMs?: number } = {},
  ): LLMProvider {
    const baseDelay = opts.baseDelayMs ?? 60;
    const slowDelay = opts.slowDelayMs ?? 400;
    return {
      chat: vi.fn(async (req: ChatRequest) => {
        const route = routes.find((r) =>
          (req.system ?? "").includes(r.match),
        );
        if (route?.behavior === "fail") {
          await new Promise((r) => setTimeout(r, baseDelay));
          throw new Error(`[${route.match}] LLM exploded`);
        }
        const delay = route?.behavior === "slow" ? slowDelay : baseDelay;
        await new Promise((r) => setTimeout(r, delay));
        return textResponse(`[${route?.match ?? "unknown"}] ok`);
      }),
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: "text", text: "stub" } as StreamChunk;
      },
    };
  }

  function createParallelScore(
    provider: LLMProvider,
    agentIds: string[],
  ): ScoreConfig {
    const agents: ScoreConfig["agents"] = {};
    for (const id of agentIds) {
      agents[id] = {
        name: id,
        // system_prompt carries the route tag so the mock provider can identify callers.
        system_prompt: `tag:${id}`,
        voices: [],
      };
    }
    return {
      provider,
      agents,
      entry: { type: "parallel", agents: agentIds },
    };
  }

  describe("runParallel", () => {
    it("runs agents concurrently (verified via wall-clock timing)", async () => {
      const DELAY = 80;
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "ok" },
          { match: "tag:b", behavior: "ok" },
          { match: "tag:c", behavior: "ok" },
        ],
        { baseDelayMs: DELAY },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b", "c"]),
      );

      const start = Date.now();
      const results = await router.runParallel([
        { agent_id: "a", input: "x" },
        { agent_id: "b", input: "x" },
        { agent_id: "c", input: "x" },
      ]);
      const duration = Date.now() - start;

      expect(results.size).toBe(3);
      expect(results.get("a")?.output).toBe("[tag:a] ok");
      expect(results.get("b")?.output).toBe("[tag:b] ok");
      expect(results.get("c")?.output).toBe("[tag:c] ok");

      // Sequential would take >= 3*DELAY = 240ms. Parallel should be < 2*DELAY.
      // Leave generous slack for CI to avoid flakes.
      expect(duration).toBeLessThan(DELAY * 2);
    });

    it("one failure does not block the other agents", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:good", behavior: "ok" },
          { match: "tag:bad", behavior: "fail" },
          { match: "tag:also_good", behavior: "ok" },
        ],
        { baseDelayMs: 30 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["good", "bad", "also_good"]),
      );

      const results = await router.runParallel([
        { agent_id: "good", input: "x" },
        { agent_id: "bad", input: "x" },
        { agent_id: "also_good", input: "x" },
      ]);

      expect(results.size).toBe(3);
      expect(results.get("good")?.output).toBe("[tag:good] ok");
      expect(results.get("also_good")?.output).toBe("[tag:also_good] ok");
      expect(results.get("bad")?.output).toContain("[error]");
      expect(results.get("bad")?.output).toContain("LLM exploded");
    });

    it("timeout_ms kills any agent that takes too long", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:fast", behavior: "ok" },
          { match: "tag:slow", behavior: "slow" },
        ],
        { baseDelayMs: 20, slowDelayMs: 500 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["fast", "slow"]),
      );

      const start = Date.now();
      const results = await router.runParallel(
        [
          { agent_id: "fast", input: "x" },
          { agent_id: "slow", input: "x" },
        ],
        { timeout_ms: 80 },
      );
      const duration = Date.now() - start;

      expect(results.get("fast")?.output).toBe("[tag:fast] ok");
      expect(results.get("slow")?.output).toContain("[error]");
      expect(results.get("slow")?.output).toMatch(/timeout/i);
      // We should NOT wait out the slow agent's full 500ms delay.
      expect(duration).toBeLessThan(300);
    });

    it("emits parallel:start and parallel:complete events", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "ok" },
          { match: "tag:b", behavior: "ok" },
        ],
        { baseDelayMs: 10 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b"]),
      );

      const events: TuttiEvent[] = [];
      router.events.on("parallel:start", (e) => events.push(e));
      router.events.on("parallel:complete", (e) => events.push(e));

      await router.runParallel([
        { agent_id: "a", input: "x" },
        { agent_id: "b", input: "x" },
      ]);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("parallel:start");
      expect((events[0] as Extract<TuttiEvent, { type: "parallel:start" }>).agents)
        .toEqual(["a", "b"]);
      expect(events[1].type).toBe("parallel:complete");
      expect((events[1] as Extract<TuttiEvent, { type: "parallel:complete" }>).results)
        .toEqual(["a", "b"]);
    });

    it("gives each agent its own session (no shared session_id)", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "ok" },
          { match: "tag:b", behavior: "ok" },
        ],
        { baseDelayMs: 10 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b"]),
      );

      const results = await router.runParallel([
        { agent_id: "a", input: "x" },
        { agent_id: "b", input: "x" },
      ]);

      const sa = results.get("a")?.session_id;
      const sb = results.get("b")?.session_id;
      expect(sa).toBeTruthy();
      expect(sb).toBeTruthy();
      expect(sa).not.toBe(sb);
    });

    it("rejects when an input references an unknown agent", async () => {
      const provider = createDelayedProvider(
        [{ match: "tag:a", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      const router = new AgentRouter(createParallelScore(provider, ["a"]));

      await expect(
        router.runParallel([{ agent_id: "ghost", input: "x" }]),
      ).rejects.toThrow(/unknown agent "ghost"/);
    });

    it("rejects when inputs is empty", async () => {
      const provider = createDelayedProvider(
        [{ match: "tag:a", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      const router = new AgentRouter(createParallelScore(provider, ["a"]));
      await expect(router.runParallel([])).rejects.toThrow(
        /at least one input/,
      );
    });

    it("handles a single input (trivial fan-out of 1)", async () => {
      const provider = createDelayedProvider(
        [{ match: "tag:solo", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["solo"]),
      );

      const results = await router.runParallel([
        { agent_id: "solo", input: "x" },
      ]);

      expect(results.size).toBe(1);
      expect(results.get("solo")?.output).toBe("[tag:solo] ok");
    });

    it("returns a fully-populated map even when every agent fails", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "fail" },
          { match: "tag:b", behavior: "fail" },
        ],
        { baseDelayMs: 5 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b"]),
      );

      const results = await router.runParallel([
        { agent_id: "a", input: "x" },
        { agent_id: "b", input: "x" },
      ]);

      expect(results.size).toBe(2);
      expect(results.get("a")?.output).toMatch(/\[error\]/);
      expect(results.get("b")?.output).toMatch(/\[error\]/);
    });

    it("parallel:complete excludes agents that failed", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:ok", behavior: "ok" },
          { match: "tag:bad", behavior: "fail" },
        ],
        { baseDelayMs: 5 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["ok", "bad"]),
      );

      let completeEvent:
        | Extract<TuttiEvent, { type: "parallel:complete" }>
        | undefined;
      router.events.on("parallel:complete", (e) => {
        completeEvent = e;
      });

      await router.runParallel([
        { agent_id: "ok", input: "x" },
        { agent_id: "bad", input: "x" },
      ]);

      // Only successful agents appear in parallel:complete.results
      expect(completeEvent?.results).toEqual(["ok"]);
    });

    it("surfaces a non-Error rejection value as a string", async () => {
      // Provider whose chat() rejects with a plain string — exercises the
      // `String(outcome.error)` fallback in runParallelInternal's error path.
      const provider: LLMProvider = {
        chat: vi.fn(() => Promise.reject("string-rejection")),
        async *stream(): AsyncIterable<StreamChunk> {
          yield { type: "text", text: "stub" } as StreamChunk;
        },
      };
      const router = new AgentRouter(createParallelScore(provider, ["a"]));

      const results = await router.runParallel([
        { agent_id: "a", input: "x" },
      ]);

      expect(results.get("a")?.output).toContain("[error]");
      expect(results.get("a")?.output).toContain("string-rejection");
    });
  });

  describe("parallel entry config", () => {
    it("constructor accepts { type: 'parallel' } entry without delegates", () => {
      const provider = createDelayedProvider(
        [{ match: "tag:a", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      expect(
        () => new AgentRouter(createParallelScore(provider, ["a"])),
      ).not.toThrow();
    });

    it("run() with parallel entry fans input out and returns merged AgentResult", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "ok" },
          { match: "tag:b", behavior: "ok" },
        ],
        { baseDelayMs: 20 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b"]),
      );

      const result = await router.run("question");

      expect(result.output).toContain("[a]");
      expect(result.output).toContain("[b]");
      // Merged usage is the sum of both agents
      expect(result.usage.input_tokens).toBe(20); // 10 + 10 from textResponse
      expect(result.usage.output_tokens).toBe(10); // 5 + 5
    });

    it("parallel entry rejects an empty agents[] at construction time", () => {
      const provider = createDelayedProvider(
        [{ match: "tag:a", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      const score: ScoreConfig = {
        provider,
        agents: {
          a: { name: "A", system_prompt: "tag:a", voices: [] },
        },
        entry: { type: "parallel", agents: [] },
      };
      expect(() => new AgentRouter(score)).toThrow(/at least one agent/);
    });

    it("parallel entry rejects unknown agents at construction time", () => {
      const provider = createDelayedProvider(
        [{ match: "tag:a", behavior: "ok" }],
        { baseDelayMs: 5 },
      );
      const score: ScoreConfig = {
        provider,
        agents: {
          a: { name: "A", system_prompt: "tag:a", voices: [] },
        },
        entry: { type: "parallel", agents: ["a", "ghost"] },
      };
      expect(() => new AgentRouter(score)).toThrow(/"ghost" not found/);
    });

    it("runParallelWithSummary returns rollup metrics", async () => {
      const provider = createDelayedProvider(
        [
          { match: "tag:a", behavior: "ok" },
          { match: "tag:b", behavior: "ok" },
        ],
        { baseDelayMs: 15 },
      );
      const router = new AgentRouter(
        createParallelScore(provider, ["a", "b"]),
      );

      const summary = await router.runParallelWithSummary([
        { agent_id: "a", input: "x" },
        { agent_id: "b", input: "x" },
      ]);

      expect(summary.results.size).toBe(2);
      expect(summary.merged_output).toContain("[a]");
      expect(summary.merged_output).toContain("[b]");
      expect(summary.total_usage.input_tokens).toBeGreaterThan(0);
      expect(summary.total_cost_usd).toBeGreaterThan(0);
      expect(summary.duration_ms).toBeGreaterThanOrEqual(0);
    });
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
