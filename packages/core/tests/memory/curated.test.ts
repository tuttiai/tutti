import { describe, it, expect, beforeEach } from "vitest";
import type { Tool, ToolContext, TuttiEvent } from "@tuttiai/types";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";
import {
  MemoryEnforcer,
  createMemoryHelpers,
  createMemoryTools,
} from "../../src/memory/curated.js";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

function getTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

function makeCtx(agent_name: string): ToolContext {
  return { session_id: "sess-1", agent_name };
}

function captureEvents(bus: EventBus): TuttiEvent[] {
  const seen: TuttiEvent[] = [];
  bus.on("memory:write", (e) => seen.push(e));
  bus.on("memory:read", (e) => seen.push(e));
  bus.on("memory:delete", (e) => seen.push(e));
  return seen;
}

describe("createMemoryTools — remember", () => {
  let store: InMemorySemanticStore;
  let bus: EventBus;
  beforeEach(() => {
    store = new InMemorySemanticStore();
    bus = new EventBus();
  });

  it("writes an entry tagged source: 'agent' with the supplied tags", async () => {
    const events = captureEvents(bus);
    const [remember] = createMemoryTools({
      store,
      agentName: AGENT_A,
      events: bus,
    });
    const result = await remember!.execute(
      { content: "User likes ts", tags: ["preference"] },
      makeCtx(AGENT_A),
    );
    expect(result.is_error).toBeUndefined();
    const all = await store.listByAgent(AGENT_A);
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe("agent");
    expect(all[0]!.tags).toEqual(["preference"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "memory:write",
      agent_name: AGENT_A,
      source: "agent",
      tags: ["preference"],
    });
  });

  it("rejects empty content via the zod schema", async () => {
    const [remember] = createMemoryTools({ store, agentName: AGENT_A });
    await expect(
      remember!.parameters.parseAsync({ content: "" }),
    ).rejects.toThrow(/content is required/);
  });
});

describe("createMemoryTools — recall", () => {
  let store: InMemorySemanticStore;
  let bus: EventBus;
  beforeEach(() => {
    store = new InMemorySemanticStore();
    bus = new EventBus();
  });

  it("returns matches sorted by relevance and emits memory:read", async () => {
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin is the capital of Germany",
      metadata: {},
      source: "agent",
    });
    await store.add({
      agent_name: AGENT_A,
      content: "Tokyo is the capital of Japan",
      metadata: {},
      source: "agent",
    });
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin has great coffee shops",
      metadata: {},
      source: "agent",
    });

    const events = captureEvents(bus);
    const tools = createMemoryTools({
      store,
      agentName: AGENT_A,
      events: bus,
    });
    const recall = getTool(tools, "recall");
    const result = await recall.execute(
      { query: "Berlin coffee" },
      makeCtx(AGENT_A),
    );
    expect(result.content).toContain("Berlin has great coffee shops");
    const lines = result.content.split("\n");
    // First "- (id) ..." line should be the higher-overlap match
    const firstMatch = lines.find((l) => l.startsWith("- "));
    expect(firstMatch).toContain("Berlin has great coffee shops");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "memory:read",
      agent_name: AGENT_A,
      query: "Berlin coffee",
    });
  });

  it("returns 'No matching memories' on a miss", async () => {
    const tools = createMemoryTools({ store, agentName: AGENT_A });
    const recall = getTool(tools, "recall");
    const result = await recall.execute(
      { query: "nothing" },
      makeCtx(AGENT_A),
    );
    expect(result.content).toBe("No matching memories.");
  });
});

describe("createMemoryTools — forget", () => {
  it("deletes the named entry and emits memory:delete with reason 'explicit'", async () => {
    const store = new InMemorySemanticStore();
    const bus = new EventBus();
    const events = captureEvents(bus);
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "ephemeral",
      metadata: {},
      source: "agent",
    });
    const tools = createMemoryTools({
      store,
      agentName: AGENT_A,
      events: bus,
    });
    const forget = getTool(tools, "forget");
    const result = await forget.execute({ id: entry.id }, makeCtx(AGENT_A));
    expect(result.is_error).toBeUndefined();
    expect(await store.listByAgent(AGENT_A)).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "memory:delete",
      reason: "explicit",
      entry_id: entry.id,
    });
  });
});

describe("createMemoryTools — LRU eviction", () => {
  it("drops the least-recently-used entry when cap is exceeded", async () => {
    const store = new InMemorySemanticStore();
    const bus = new EventBus();
    const tools = createMemoryTools({
      store,
      agentName: AGENT_A,
      maxEntriesPerAgent: 3,
      events: bus,
    });
    const remember = getTool(tools, "remember");
    const recall = getTool(tools, "recall");

    await remember.execute({ content: "first" }, makeCtx(AGENT_A));
    await new Promise((r) => setTimeout(r, 5));
    await remember.execute({ content: "second" }, makeCtx(AGENT_A));
    await new Promise((r) => setTimeout(r, 5));
    await remember.execute({ content: "third" }, makeCtx(AGENT_A));

    // Bump 'first' so that 'second' becomes least-recently used.
    await new Promise((r) => setTimeout(r, 5));
    await recall.execute({ query: "first" }, makeCtx(AGENT_A));

    const evictions: TuttiEvent[] = [];
    bus.on("memory:delete", (e) => {
      if (e.reason === "lru_eviction") evictions.push(e);
    });

    await new Promise((r) => setTimeout(r, 5));
    await remember.execute({ content: "fourth" }, makeCtx(AGENT_A));

    const remaining = await store.listByAgent(AGENT_A);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((e) => e.content).sort()).toEqual([
      "first",
      "fourth",
      "third",
    ]);
    expect(evictions).toHaveLength(1);
  });
});

describe("createMemoryTools — cross-agent isolation", () => {
  it("agent A's recall does not surface agent B's entries", async () => {
    const store = new InMemorySemanticStore();
    const aTools = createMemoryTools({ store, agentName: AGENT_A });
    const bTools = createMemoryTools({ store, agentName: AGENT_B });
    const aRemember = getTool(aTools, "remember");
    const bRemember = getTool(bTools, "remember");
    const aRecall = getTool(aTools, "recall");

    await aRemember.execute(
      { content: "shared keyword secret" },
      makeCtx(AGENT_A),
    );
    await bRemember.execute(
      { content: "shared keyword poison" },
      makeCtx(AGENT_B),
    );

    const result = await aRecall.execute(
      { query: "shared keyword" },
      makeCtx(AGENT_A),
    );
    expect(result.content).toContain("secret");
    expect(result.content).not.toContain("poison");
  });
});

describe("createMemoryHelpers — wraps the same enforcer as the tools", () => {
  it("a write through helpers is visible to a tool-driven recall", async () => {
    const store = new InMemorySemanticStore();
    const bus = new EventBus();
    const enforcer = new MemoryEnforcer(store, AGENT_A, 100, bus);
    const helpers = createMemoryHelpers(enforcer);
    const tools = createMemoryTools({ enforcer });
    const recall = getTool(tools, "recall");

    await helpers.remember("Berlin is great", { source: "system" });
    const result = await recall.execute(
      { query: "Berlin" },
      makeCtx(AGENT_A),
    );
    expect(result.content).toContain("Berlin is great");
  });
});
