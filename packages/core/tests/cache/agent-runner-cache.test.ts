import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { InMemoryToolCache } from "../../src/cache/in-memory-cache.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";
import type {
  AgentConfig,
  TuttiEvent,
  Voice,
  ChatResponse,
} from "@tuttiai/types";

/** Voice with a single tool whose execute() is a vitest spy. */
function makeSpyVoice(toolName: string, voiceName = toolName): {
  voice: Voice;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (input: { path: string }) => ({
    content: `read:${input.path}`,
  }));
  const voice: Voice = {
    name: voiceName,
    required_permissions: [],
    tools: [
      {
        name: toolName,
        description: "Test tool",
        parameters: z.object({ path: z.string() }),
        execute: spy,
      },
    ],
  };
  return { voice, spy };
}

/** Build a ChatResponse sequence: tool call, final text, tool call, final text. */
function twoCallsWithSameInput(toolName: string, input: unknown): ChatResponse[] {
  return [
    toolUseResponse(toolName, input, "tu-1"),
    textResponse("first done"),
    toolUseResponse(toolName, input, "tu-2"),
    textResponse("second done"),
  ];
}

describe("AgentRunner + ToolCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a second identical call from cache", async () => {
    const { voice, spy } = makeSpyVoice("read_thing");
    const provider = createMockProvider(
      twoCallsWithSameInput("read_thing", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true },
    };

    // Turn 1: tool executes → result cached.
    const r1 = await runner.run(agent, "read a.md");
    // Turn 2: same input → cache hit, executor NOT called again.
    const r2 = await runner.run(agent, "read a.md again", r1.session_id);

    expect(spy).toHaveBeenCalledOnce();
    expect(r2.output).toBe("second done");
  });

  it("emits cache:hit on the second identical call", async () => {
    const { voice } = makeSpyVoice("read_thing");
    const provider = createMockProvider(
      twoCallsWithSameInput("read_thing", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const captured: TuttiEvent[] = [];
    events.on("cache:hit", (e) => captured.push(e));
    events.on("cache:miss", (e) => captured.push(e));

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true },
    };

    const r1 = await runner.run(agent, "read a.md");
    await runner.run(agent, "read a.md again", r1.session_id);

    // First call: miss. Second call: hit.
    expect(captured.map((e) => e.type)).toEqual(["cache:miss", "cache:hit"]);
    const hit = captured[1] as Extract<TuttiEvent, { type: "cache:hit" }>;
    expect(hit.tool).toBe("read_thing");
    expect(hit.agent_name).toBe("test-agent");
  });

  it("TTL expiry causes a miss", async () => {
    vi.useFakeTimers();

    const { voice, spy } = makeSpyVoice("read_thing");
    const provider = createMockProvider(
      twoCallsWithSameInput("read_thing", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    // Short TTL on the cache so we can expire it deterministically.
    const cache = new InMemoryToolCache({ default_ttl_ms: 1000 });
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const captured: TuttiEvent[] = [];
    events.on("cache:hit", (e) => captured.push(e));
    events.on("cache:miss", (e) => captured.push(e));

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true },
    };

    const r1 = await runner.run(agent, "first");
    vi.advanceTimersByTime(1500); // past TTL
    await runner.run(agent, "second", r1.session_id);

    // Both calls should have missed (first: cold miss, second: TTL miss).
    expect(captured.map((e) => e.type)).toEqual(["cache:miss", "cache:miss"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache write_file (built-in write-tool exclusion)", async () => {
    const { voice, spy } = makeSpyVoice("write_file", "fs");
    const provider = createMockProvider(
      twoCallsWithSameInput("write_file", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const captured: TuttiEvent[] = [];
    events.on("cache:hit", (e) => captured.push(e));
    events.on("cache:miss", (e) => captured.push(e));

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true },
    };

    const r1 = await runner.run(agent, "write");
    await runner.run(agent, "write again", r1.session_id);

    // Write tool must execute both times and emit NO cache events.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(0);
  });

  it("does not cache user-excluded tools", async () => {
    const { voice, spy } = makeSpyVoice("run_migration");
    const provider = createMockProvider(
      twoCallsWithSameInput("run_migration", { path: "x" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true, excluded_tools: ["run_migration"] },
    };

    const r1 = await runner.run(agent, "first");
    await runner.run(agent, "second", r1.session_id);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache when agent.cache.enabled is false", async () => {
    const { voice, spy } = makeSpyVoice("read_thing");
    const provider = createMockProvider(
      twoCallsWithSameInput("read_thing", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: false },
    };

    const r1 = await runner.run(agent, "first");
    await runner.run(agent, "second", r1.session_id);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache errored results (is_error: true)", async () => {
    const spy = vi.fn(async () => ({
      content: "boom",
      is_error: true as const,
    }));
    const voice: Voice = {
      name: "flaky",
      required_permissions: [],
      tools: [
        {
          name: "flaky_read",
          description: "sometimes fails",
          parameters: z.object({ path: z.string() }),
          execute: spy,
        },
      ],
    };
    const provider = createMockProvider(
      twoCallsWithSameInput("flaky_read", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const cache = new InMemoryToolCache();
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true },
    };

    const r1 = await runner.run(agent, "first");
    await runner.run(agent, "second", r1.session_id);

    // Error result should not pin the cache — second call re-executes.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("respects per-agent ttl_ms override", async () => {
    vi.useFakeTimers();

    const { voice, spy } = makeSpyVoice("read_thing");
    const provider = createMockProvider(
      twoCallsWithSameInput("read_thing", { path: "a.md" }),
    );
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    // Big default TTL — agent override should still expire quickly.
    const cache = new InMemoryToolCache({ default_ttl_ms: 60_000 });
    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      cache,
    );

    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      cache: { enabled: true, ttl_ms: 500 },
    };

    const r1 = await runner.run(agent, "first");
    vi.advanceTimersByTime(600); // past agent's 500ms override
    await runner.run(agent, "second", r1.session_id);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
