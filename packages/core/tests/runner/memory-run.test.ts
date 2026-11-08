import { afterEach, describe, it, expect, vi } from "vitest";
import type { AgentConfig, ChatMessage, ChatRequest, ToolContext } from "@tuttiai/types";

import {
  attachMemoryHelpers,
  curatedToolsFor,
  inferUserMemories,
  requestInferredFacts,
  resolveSemanticMemory,
  storeInferredFacts,
  type InferUserMemoriesInput,
} from "../../src/runner/memory-run.js";
import { EventBus } from "../../src/event-bus.js";
import { logger } from "../../src/logger.js";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import { simpleAgent } from "../helpers/mock-provider.js";

const USER = "u1";

const agent = (memory: AgentConfig["memory"]): AgentConfig => ({ ...simpleAgent, memory });
const ctx = (): ToolContext => ({ session_id: "s", agent_name: simpleAgent.name });
const messages = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));

const inferInput = (over: Partial<InferUserMemoriesInput> = {}): InferUserMemoriesInput => ({
  agentName: simpleAgent.name,
  model: "test-model",
  userId: USER,
  messages: messages(2),
  store: new MemoryUserMemoryStore(),
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSemanticMemory", () => {
  const events = new EventBus();

  it("returns undefined when semantic memory is absent or disabled", () => {
    const fallback = new InMemorySemanticStore();
    expect(resolveSemanticMemory(simpleAgent, fallback, events)).toBeUndefined();
    expect(resolveSemanticMemory(agent({ semantic: { enabled: false } }), fallback, events)).toBeUndefined();
  });

  it("returns undefined when enabled but no store is available", () => {
    expect(resolveSemanticMemory(agent({ semantic: { enabled: true } }), undefined, events)).toBeUndefined();
  });

  it("uses the runner's store when the config has none", () => {
    const fallback = new InMemorySemanticStore();
    const mem = resolveSemanticMemory(agent({ semantic: { enabled: true } }), fallback, events);
    expect(mem?.store).toBe(fallback);
    expect(mem?.enforcer).toBeDefined();
  });

  it("prefers the store from the agent's config", () => {
    const own = new InMemorySemanticStore();
    const mem = resolveSemanticMemory(agent({ semantic: { enabled: true, store: own } }), new InMemorySemanticStore(), events);
    expect(mem?.store).toBe(own);
  });

  it("caps entries at max_entries_per_agent through the enforcer", async () => {
    const store = new InMemorySemanticStore();
    const mem = resolveSemanticMemory(agent({ semantic: { enabled: true, max_entries_per_agent: 1 } }), store, events);
    await mem?.enforcer.write("first");
    await mem?.enforcer.write("second");
    expect(await store.search("first second", simpleAgent.name, 10)).toHaveLength(1);
  });
});

describe("curatedToolsFor", () => {
  const events = new EventBus();

  it("returns no tools without semantic memory", () => {
    expect(curatedToolsFor(undefined)).toEqual([]);
  });

  it("returns remember, recall and forget by default", () => {
    const mem = resolveSemanticMemory(agent({ semantic: { enabled: true } }), new InMemorySemanticStore(), events);
    expect(curatedToolsFor(mem).map((t) => t.name)).toEqual(["remember", "recall", "forget"]);
  });

  it("returns no tools when curated_tools is false", () => {
    const mem = resolveSemanticMemory(
      agent({ semantic: { enabled: true, curated_tools: false } }),
      new InMemorySemanticStore(),
      events,
    );
    expect(curatedToolsFor(mem)).toEqual([]);
  });
});

describe("attachMemoryHelpers", () => {
  it("attaches nothing when there is no memory", () => {
    const c = ctx();
    attachMemoryHelpers(c, {});
    expect(c.user_memory).toBeUndefined();
    expect(c.memory).toBeUndefined();
  });

  it("does not attach user_memory without a user id", () => {
    const c = ctx();
    attachMemoryHelpers(c, { userMemory: { store: new MemoryUserMemoryStore(), cfg: { store: "memory" } } });
    expect(c.user_memory).toBeUndefined();
  });

  it("binds user_memory to the user and defaults importance to 3", async () => {
    const store = new MemoryUserMemoryStore();
    const c = ctx();
    attachMemoryHelpers(c, { userId: USER, userMemory: { store, cfg: { store: "memory" } } });
    const { id } = (await c.user_memory?.remember("User likes tea")) ?? { id: "" };
    const [stored] = await store.list(USER);
    expect(stored).toMatchObject({ id, content: "User likes tea", source: "explicit", importance: 3 });
    expect(stored?.tags).toBeUndefined();
  });

  it("passes importance, tags and expires_at through", async () => {
    const store = new MemoryUserMemoryStore();
    const spy = vi.spyOn(store, "store");
    const c = ctx();
    attachMemoryHelpers(c, { userId: USER, userMemory: { store, cfg: { store: "memory" } } });
    const expires_at = new Date("2100-01-01T00:00:00Z");
    await c.user_memory?.remember("x", { importance: 1, tags: ["t"], expires_at });
    expect(spy).toHaveBeenCalledWith(USER, "x", { source: "explicit", importance: 1, tags: ["t"], expires_at });
  });

  it("attaches memory helpers that share the run's enforcer", async () => {
    const store = new InMemorySemanticStore();
    const mem = resolveSemanticMemory(agent({ semantic: { enabled: true } }), store, new EventBus());
    if (!mem) throw new Error("fixture");
    const write = vi.spyOn(mem.enforcer, "write");
    const c = ctx();
    attachMemoryHelpers(c, { semantic: mem });
    await c.memory?.remember("tea fact");
    expect(write).toHaveBeenCalledOnce();
  });
});

describe("requestInferredFacts", () => {
  it("sends the last 10 messages with the extraction prompt and parses the reply", async () => {
    const complete = vi.fn(async (_req: ChatRequest) => '  ["User likes tea."]  ');
    const input = inferInput({ messages: messages(14) });
    expect(await requestInferredFacts(complete, input)).toEqual(["User likes tea."]);
    const req = complete.mock.calls[0]?.[0];
    expect(req?.model).toBe("test-model");
    expect(req?.system).toContain("Return a JSON array of strings");
    expect(req?.messages).toEqual(input.messages.slice(-10));
    expect(req).not.toHaveProperty("signal");
    expect(req).not.toHaveProperty("max_tokens");
  });

  it("does not call the model when there are no messages", async () => {
    const complete = vi.fn(async () => "[]");
    expect(await requestInferredFacts(complete, inferInput({ messages: [] }))).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("logs and returns undefined when the call fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const complete = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(await requestInferredFacts(complete, inferInput())).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { error: "provider down", agent: simpleAgent.name },
      expect.stringContaining("auto-infer LLM call failed"),
    );
  });
});

describe("storeInferredFacts", () => {
  it("stores each fact as an inferred memory of importance 2", async () => {
    const input = inferInput();
    await storeInferredFacts(["User A.", "User B."], input);
    const stored = await input.store.list(USER);
    expect(stored.map((m) => [m.content, m.source, m.importance]).sort()).toEqual([
      ["User A.", "inferred", 2],
      ["User B.", "inferred", 2],
    ]);
  });

  it("logs a fact that fails to store and still stores the rest", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const input = inferInput();
    const real = input.store.store.bind(input.store);
    vi.spyOn(input.store, "store").mockImplementation(async (user, content, opts) => {
      if (content === "User bad.") throw new Error("write failed");
      return real(user, content, opts);
    });
    await storeInferredFacts(["User A.", "User bad.", "User C."], input);
    expect((await input.store.list(USER)).map((m) => m.content).sort()).toEqual(["User A.", "User C."]);
    expect(warn).toHaveBeenCalledWith(
      { error: "write failed", agent: simpleAgent.name, user_id: USER },
      "User-memory auto-infer store failed for one fact",
    );
  });
});

describe("inferUserMemories", () => {
  it("stores the facts the model returns", async () => {
    const input = inferInput();
    await inferUserMemories(async () => '```json\n["User likes tea."]\n```', input);
    expect((await input.store.list(USER)).map((m) => m.content)).toEqual(["User likes tea."]);
  });

  it("stores nothing when the reply parses to no facts", async () => {
    const input = inferInput();
    const spy = vi.spyOn(input.store, "store");
    await inferUserMemories(async () => "nothing new", input);
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows a failed model call", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const input = inferInput();
    await expect(
      inferUserMemories(async () => Promise.reject(new Error("down")), input),
    ).resolves.toBeUndefined();
    expect(await input.store.list(USER)).toEqual([]);
  });
});
