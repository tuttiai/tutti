import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../../src/agent-runner.js";
import { EventBus } from "../../../src/event-bus.js";
import { InMemorySessionStore } from "../../../src/session-store.js";
import { MemoryUserMemoryStore } from "../../../src/memory/user/memory-store.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "../../helpers/mock-provider.js";
import type {
  AgentConfig,
  ChatRequest,
  Tool,
  ToolContext,
  Voice,
} from "@tuttiai/types";

const USER = "user-alex";

/** Build an agent with `memory.user_memory.store: "memory"` set. */
function userMemoryAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...simpleAgent,
    memory: {
      user_memory: {
        store: "memory",
        inject_limit: 10,
        ...((overrides.memory?.user_memory ?? {}) as object),
      },
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Memory injection into the system prompt                            */
/* ------------------------------------------------------------------ */

describe("user memory — injection into system prompt", () => {
  it("appends a 'What I remember about you' section when user_id is set and memories exist", async () => {
    const store = new MemoryUserMemoryStore();
    // The in-memory backend uses literal substring match (per spec —
    // good enough for dev/testing). Pick stored content + query so the
    // match exercises the injection path.
    await store.store(USER, "User prefers TypeScript over JavaScript", { importance: 3 });
    await store.store(USER, "User's name is Alex", { importance: 3 });
    await store.store(USER, "User works at a fintech startup", { importance: 2 });

    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    // Substring search matches when the *query* is contained in the
    // stored content. "User" appears in every stored memory (case-
    // insensitive), so all three surface.
    await runner.run(userMemoryAgent(), "User", undefined, { user_id: USER });

    // Inspect the actual system prompt sent to the provider.
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    const sys = req.system!;

    expect(sys).toContain("What I remember about you:");
    expect(sys).toContain("- User prefers TypeScript over JavaScript [importance: high]");
    expect(sys).toContain("- User's name is Alex [importance: high]");
    expect(sys).toContain("- User works at a fintech startup [importance: normal]");
  });

  it("only injects memories that substring-match the input (in-memory backend)", async () => {
    const store = new MemoryUserMemoryStore();
    await store.store(USER, "User prefers TypeScript over JavaScript");
    await store.store(USER, "User loves coffee in the morning");

    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    // The in-memory store's search is literal substring on content —
    // documented as dev-only; the Postgres backend uses trigram. Query
    // "TypeScript" matches the TypeScript memory, not the coffee one.
    await runner.run(userMemoryAgent(), "TypeScript", undefined, {
      user_id: USER,
    });

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    const sys = req.system!;
    expect(sys).toContain("TypeScript");
    expect(sys).not.toContain("coffee");
  });

  it("respects inject_limit", async () => {
    const store = new MemoryUserMemoryStore();
    for (let i = 0; i < 10; i++) {
      await store.store(USER, "User fact match-" + i);
    }

    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({ memory: { user_memory: { store: "memory", inject_limit: 3 } } }),
      "match",
      undefined,
      { user_id: USER },
    );

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    const sys = req.system!;
    const matchLines = sys.split("\n").filter((l) => l.includes("User fact match-"));
    expect(matchLines).toHaveLength(3);
  });

  it("does not inject anything when user_id is omitted", async () => {
    const store = new MemoryUserMemoryStore();
    await store.store(USER, "User prefers TypeScript");

    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(userMemoryAgent(), "Hello"); // no options

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    expect(req.system).not.toContain("What I remember about you:");
    expect(req.system).not.toContain("TypeScript");
  });

  it("does not inject anything when the agent has no memory.user_memory config", async () => {
    const store = new MemoryUserMemoryStore();
    await store.store(USER, "User prefers TypeScript");

    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());

    // simpleAgent has no memory config — even with user_id set, nothing
    // should be fetched or injected.
    await runner.run(simpleAgent, "Hello", undefined, { user_id: USER });

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    expect(req.system).not.toContain("What I remember about you:");
  });

  it("section is positioned AFTER the base system prompt", async () => {
    const store = new MemoryUserMemoryStore();
    await store.store(USER, "User name is Alex");

    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({ system_prompt: "BASE_PROMPT_MARKER" }),
      "Alex",
      undefined,
      { user_id: USER },
    );

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[0]![0]!;
    const sys = req.system!;
    const baseIdx = sys.indexOf("BASE_PROMPT_MARKER");
    const memIdx = sys.indexOf("What I remember about you:");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(memIdx).toBeGreaterThan(baseIdx);
  });
});

/* ------------------------------------------------------------------ */
/*  toolContext.user_memory.remember                                   */
/* ------------------------------------------------------------------ */

describe("user memory — toolContext.user_memory.remember", () => {
  it("stores a memory with source: 'explicit' when called from a tool", async () => {
    const store = new MemoryUserMemoryStore();
    let capturedContext: ToolContext | undefined;

    const rememberTool: Tool<{ fact: string }> = {
      name: "remember_fact",
      description: "Remember a fact about the user",
      parameters: z.object({ fact: z.string() }),
      execute: async (input, ctx) => {
        capturedContext = ctx;
        const r = await ctx.user_memory!.remember(input.fact);
        return { content: "stored " + r.id };
      },
    };

    const voice: Voice = {
      name: "memory-voice",
      required_permissions: [],
      tools: [rememberTool],
    };

    const provider = createMockProvider([
      toolUseResponse("remember_fact", { fact: "User prefers dark mode" }),
      textResponse("Got it."),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({ voices: [voice] }),
      "Remember that I prefer dark mode",
      undefined,
      { user_id: USER },
    );

    const stored = await store.list(USER);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe("User prefers dark mode");
    expect(stored[0]!.source).toBe("explicit");
    // Default importance for tool-issued remember is 3 (deliberate intent).
    expect(stored[0]!.importance).toBe(3);
    // The user_id is bound — tool code never had to pass it.
    expect(capturedContext?.user_id).toBe(USER);
  });

  it("respects the importance / tags / expires_at options", async () => {
    const store = new MemoryUserMemoryStore();
    const expires = new Date(Date.now() + 60_000);

    const rememberTool: Tool<Record<string, never>> = {
      name: "remember_with_options",
      description: "Remember with options",
      parameters: z.object({}),
      execute: async (_input, ctx) => {
        await ctx.user_memory!.remember("low-priority fact", {
          importance: 1,
          tags: ["test"],
          expires_at: expires,
        });
        return { content: "ok" };
      },
    };

    const provider = createMockProvider([
      toolUseResponse("remember_with_options", {}),
      textResponse("done"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({
        voices: [{ name: "v", required_permissions: [], tools: [rememberTool] }],
      }),
      "Remember",
      undefined,
      { user_id: USER },
    );

    const [stored] = await store.list(USER);
    expect(stored!.importance).toBe(1);
    expect(stored!.tags).toEqual(["test"]);
    expect(stored!.expires_at?.getTime()).toBe(expires.getTime());
  });

  it("toolContext.user_memory is undefined when user_id is absent", async () => {
    const store = new MemoryUserMemoryStore();
    let capturedContext: ToolContext | undefined;

    const tool: Tool<Record<string, never>> = {
      name: "noop",
      description: "noop",
      parameters: z.object({}),
      execute: async (_input, ctx) => {
        capturedContext = ctx;
        return { content: "ok" };
      },
    };

    const provider = createMockProvider([
      toolUseResponse("noop", {}),
      textResponse("done"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    // Run without user_id.
    await runner.run(
      userMemoryAgent({
        voices: [{ name: "v", required_permissions: [], tools: [tool] }],
      }),
      "go",
    );

    expect(capturedContext?.user_memory).toBeUndefined();
    expect(capturedContext?.user_id).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  auto_infer                                                         */
/* ------------------------------------------------------------------ */

describe("user memory — auto_infer", () => {
  it("stores extracted memories with source: 'inferred' and importance: 2", async () => {
    const store = new MemoryUserMemoryStore();

    // Three calls expected:
    //  1. agent's own LLM call (returns text, ends turn)
    //  2. auto-infer extraction call — returns a JSON array of facts
    const provider = createMockProvider([
      textResponse("Nice to meet you, Alex!"),
      textResponse(
        '["User name is Alex", "User lives in Berlin", "User works at a fintech startup"]',
      ),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({
        memory: { user_memory: { store: "memory", auto_infer: true } },
      }),
      "Hi! I'm Alex, I live in Berlin and work at a fintech startup.",
      undefined,
      { user_id: USER },
    );

    // Extraction call MUST have happened.
    expect(provider.chat).toHaveBeenCalledTimes(2);
    const extractionCall = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock.calls[1]![0]!;
    expect(extractionCall.system).toContain("Extract 0–3 new factual memories");

    const stored = await store.list(USER);
    // Ordering between the three writes is undefined when they land in
    // the same millisecond (in-memory store ties on created_at). Assert
    // set membership instead.
    expect(stored.map((m) => m.content).sort()).toEqual([
      "User lives in Berlin",
      "User name is Alex",
      "User works at a fintech startup",
    ]);
    for (const m of stored) {
      expect(m.source).toBe("inferred");
      expect(m.importance).toBe(2);
    }
  });

  it("tolerates code-fenced JSON in the extraction response", async () => {
    const store = new MemoryUserMemoryStore();
    const provider = createMockProvider([
      textResponse("Hi!"),
      textResponse('Here you go:\n```json\n["User name is Alex"]\n```'),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({
        memory: { user_memory: { store: "memory", auto_infer: true } },
      }),
      "I'm Alex",
      undefined,
      { user_id: USER },
    );

    const stored = await store.list(USER);
    expect(stored.map((m) => m.content)).toEqual(["User name is Alex"]);
  });

  it("stores nothing when the extraction returns an empty array", async () => {
    const store = new MemoryUserMemoryStore();
    const provider = createMockProvider([textResponse("ok"), textResponse("[]")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(
      userMemoryAgent({
        memory: { user_memory: { store: "memory", auto_infer: true } },
      }),
      "anything",
      undefined,
      { user_id: USER },
    );

    expect(await store.list(USER)).toEqual([]);
  });

  it("does not throw when the extraction response is malformed JSON", async () => {
    const store = new MemoryUserMemoryStore();
    const provider = createMockProvider([
      textResponse("ok"),
      textResponse("this is not JSON at all, sorry"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await expect(
      runner.run(
        userMemoryAgent({
          memory: { user_memory: { store: "memory", auto_infer: true } },
        }),
        "x",
        undefined,
        { user_id: USER },
      ),
    ).resolves.toMatchObject({ output: "ok" });

    expect(await store.list(USER)).toEqual([]);
  });

  it("skips inference when auto_infer is false (default)", async () => {
    const store = new MemoryUserMemoryStore();
    // Only ONE response — if auto_infer were on we'd need two and the
    // mock provider would throw.
    const provider = createMockProvider([textResponse("ok")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await runner.run(userMemoryAgent(), "anything", undefined, { user_id: USER });
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(await store.list(USER)).toEqual([]);
  });

  it("does not throw when the extraction LLM call itself fails", async () => {
    const store = new MemoryUserMemoryStore();
    const provider = createMockProvider([textResponse("ok")]);

    // First call returns OK; second call (inference) throws.
    const originalChat = provider.chat;
    let calls = 0;
    provider.chat = vi.fn(async (req: ChatRequest) => {
      calls++;
      if (calls === 1) return originalChat(req);
      throw new Error("provider down");
    });

    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", store);

    await expect(
      runner.run(
        userMemoryAgent({
          memory: { user_memory: { store: "memory", auto_infer: true } },
        }),
        "x",
        undefined,
        { user_id: USER },
      ),
    ).resolves.toMatchObject({ output: "ok" });
    expect(await store.list(USER)).toEqual([]);
  });
});
