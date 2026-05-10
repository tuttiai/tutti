import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

describe("InMemorySemanticStore — add", () => {
  let store: InMemorySemanticStore;
  beforeEach(() => {
    store = new InMemorySemanticStore();
  });

  it("returns a record with id, created_at, and last_accessed_at populated", async () => {
    const before = Date.now();
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "User prefers 2-space indentation",
      metadata: {},
    });
    const after = Date.now();
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.agent_name).toBe(AGENT_A);
    expect(entry.created_at).toBeInstanceOf(Date);
    expect(entry.last_accessed_at).toBeInstanceOf(Date);
    expect(entry.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it("preserves source and tags when supplied", async () => {
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "Project codename is Atlas",
      metadata: {},
      source: "agent",
      tags: ["project", "codename"],
    });
    expect(entry.source).toBe("agent");
    expect(entry.tags).toEqual(["project", "codename"]);
  });
});

describe("InMemorySemanticStore — search", () => {
  let store: InMemorySemanticStore;
  beforeEach(() => {
    store = new InMemorySemanticStore();
  });

  it("returns top-N matches sorted by token-overlap relevance", async () => {
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin is the capital of Germany",
      metadata: {},
    });
    await store.add({
      agent_name: AGENT_A,
      content: "Tokyo is the capital of Japan",
      metadata: {},
    });
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin has great coffee",
      metadata: {},
    });

    const hits = await store.search("Berlin coffee", AGENT_A);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toBe("Berlin has great coffee");
  });

  it("filters by source when options.source is set", async () => {
    await store.add({
      agent_name: AGENT_A,
      content: "system fact about Berlin",
      metadata: {},
      source: "system",
    });
    await store.add({
      agent_name: AGENT_A,
      content: "agent fact about Berlin",
      metadata: {},
      source: "agent",
    });
    const agentHits = await store.search("Berlin", AGENT_A, 5, {
      source: "agent",
    });
    expect(agentHits).toHaveLength(1);
    expect(agentHits[0]!.source).toBe("agent");
  });

  it("filters by tags — entries must contain every requested tag", async () => {
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin Berlin Berlin",
      metadata: {},
      tags: ["city"],
    });
    await store.add({
      agent_name: AGENT_A,
      content: "Berlin Berlin Berlin again",
      metadata: {},
      tags: ["city", "favourite"],
    });
    const hits = await store.search("Berlin", AGENT_A, 5, {
      tags: ["city", "favourite"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tags).toContain("favourite");
  });

  it("bumps last_accessed_at on returned entries", async () => {
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "indentation preference",
      metadata: {},
    });
    const original = entry.last_accessed_at?.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    await store.search("indentation", AGENT_A);
    const all = await store.listByAgent(AGENT_A);
    expect(all[0]!.last_accessed_at!.getTime()).toBeGreaterThan(original);
  });

  it("isolates results by agent_name", async () => {
    await store.add({
      agent_name: AGENT_A,
      content: "A's secret",
      metadata: {},
    });
    await store.add({
      agent_name: AGENT_B,
      content: "B's secret",
      metadata: {},
    });
    const aHits = await store.search("secret", AGENT_A);
    expect(aHits).toHaveLength(1);
    expect(aHits[0]!.agent_name).toBe(AGENT_A);
  });
});

describe("InMemorySemanticStore — listByAgent / touch / delete / clear", () => {
  let store: InMemorySemanticStore;
  beforeEach(() => {
    store = new InMemorySemanticStore();
  });

  it("listByAgent returns every entry for the named agent", async () => {
    await store.add({ agent_name: AGENT_A, content: "one", metadata: {} });
    await store.add({ agent_name: AGENT_A, content: "two", metadata: {} });
    await store.add({ agent_name: AGENT_B, content: "three", metadata: {} });
    const entries = await store.listByAgent(AGENT_A);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.agent_name === AGENT_A)).toBe(true);
  });

  it("touch bumps last_accessed_at without searching", async () => {
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "content",
      metadata: {},
    });
    const original = entry.last_accessed_at?.getTime() ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(entry.id);
    const [refreshed] = await store.listByAgent(AGENT_A);
    expect(refreshed!.last_accessed_at!.getTime()).toBeGreaterThan(original);
  });

  it("touch on unknown id is a no-op", async () => {
    await expect(store.touch("nope")).resolves.toBeUndefined();
  });

  it("delete removes one entry", async () => {
    const entry = await store.add({
      agent_name: AGENT_A,
      content: "drop me",
      metadata: {},
    });
    await store.delete(entry.id);
    expect(await store.listByAgent(AGENT_A)).toHaveLength(0);
  });

  it("clear removes every entry for an agent", async () => {
    await store.add({ agent_name: AGENT_A, content: "a", metadata: {} });
    await store.add({ agent_name: AGENT_A, content: "b", metadata: {} });
    await store.add({ agent_name: AGENT_B, content: "c", metadata: {} });
    await store.clear(AGENT_A);
    expect(await store.listByAgent(AGENT_A)).toHaveLength(0);
    expect(await store.listByAgent(AGENT_B)).toHaveLength(1);
  });
});
