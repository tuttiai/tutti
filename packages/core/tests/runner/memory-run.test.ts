import { afterEach, describe, it, expect, vi } from "vitest";
import type { AgentConfig, ToolContext } from "@tuttiai/types";

import {
  attachMemoryHelpers,
  curatedToolsFor,
  resolveSemanticMemory,
} from "../../src/runner/memory-run.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import { simpleAgent } from "../helpers/mock-provider.js";

const USER = "u1";

const agent = (memory: AgentConfig["memory"]): AgentConfig => ({ ...simpleAgent, memory });
const ctx = (): ToolContext => ({ session_id: "s", agent_name: simpleAgent.name });

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
