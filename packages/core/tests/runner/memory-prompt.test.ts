import { afterEach, describe, it, expect, vi } from "vitest";
import type { AgentMemoryConfig } from "@tuttiai/types";

import {
  injectMemories,
  injectProfile,
  injectSemanticMemories,
  injectUserMemories,
  type MemoryPromptInput,
} from "../../src/runner/memory-prompt.js";
import type { SemanticRunMemory } from "../../src/runner/memory-run.js";
import type { UserModelWiring } from "../../src/runner/memory-registry.js";
import { EventBus } from "../../src/event-bus.js";
import { logger } from "../../src/logger.js";
import { MemoryEnforcer } from "../../src/memory/curated.js";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import { InMemoryUserModelStore, emptyProfile } from "../../src/memory/user-model.js";
import { UserModelConsolidator } from "../../src/memory/consolidator.js";
import { createMockProvider } from "../helpers/mock-provider.js";

const USER = "u1";
const AGENT = "agent-a";

async function userModel(summary: string): Promise<UserModelWiring> {
  const store = new InMemoryUserModelStore();
  await store.upsert({ ...emptyProfile(USER), summary });
  const consolidator = new UserModelConsolidator(store, new MemoryUserMemoryStore(), createMockProvider([]));
  return { store, consolidator };
}

async function userMemory(content: string): Promise<MemoryPromptInput["userMemory"]> {
  const store = new MemoryUserMemoryStore();
  await store.store(USER, content, { importance: 2 });
  return { store, cfg: { store: "memory" } };
}

async function semantic(content: string, cfg: Partial<AgentMemoryConfig> = {}): Promise<SemanticRunMemory> {
  const store = new InMemorySemanticStore();
  await store.add({ agent_name: AGENT, content, metadata: {} });
  const enforcer = new MemoryEnforcer(store, AGENT, 1000, new EventBus());
  return { cfg: { enabled: true, ...cfg }, store, enforcer };
}

const base = (over: Partial<MemoryPromptInput>): MemoryPromptInput => ({
  agentName: AGENT,
  userId: USER,
  guardedInput: "tea",
  rawInput: "tea",
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("injectProfile", () => {
  it("renders the stored profile", async () => {
    expect(await injectProfile(base({ userModel: await userModel("Likes tea.") }))).toBe(
      "\n\nUser profile:\nLikes tea.",
    );
  });

  it("returns an empty string without a user id or user model", async () => {
    const wiring = await userModel("Likes tea.");
    expect(await injectProfile(base({ userId: undefined, userModel: wiring }))).toBe("");
    expect(await injectProfile(base({}))).toBe("");
  });

  it("returns an empty string when the user has no profile", async () => {
    const wiring = await userModel("Likes tea.");
    expect(await injectProfile(base({ userId: "someone-else", userModel: wiring }))).toBe("");
  });

  it("logs and skips a failed profile load", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const wiring = await userModel("x");
    vi.spyOn(wiring.store, "get").mockRejectedValue(new Error("db down"));
    expect(await injectProfile(base({ userModel: wiring }))).toBe("");
    expect(warn).toHaveBeenCalledWith(
      { error: "db down", agent: AGENT, user_id: USER },
      expect.stringContaining("User-model load failed"),
    );
  });
});

describe("injectUserMemories", () => {
  it("searches with the guarded input and the inject limit", async () => {
    const um = await userMemory("User likes tea");
    if (!um) throw new Error("fixture");
    const search = vi.spyOn(um.store, "search");
    um.cfg.inject_limit = 3;
    const out = await injectUserMemories(base({ guardedInput: "tea", rawInput: "RAW", userMemory: um }));
    expect(search).toHaveBeenCalledWith(USER, "tea", 3);
    expect(out).toBe("\n\nWhat I remember about you:\n- User likes tea [importance: normal]");
  });

  it("defaults the inject limit to 10", async () => {
    const um = await userMemory("User likes tea");
    if (!um) throw new Error("fixture");
    const search = vi.spyOn(um.store, "search");
    await injectUserMemories(base({ userMemory: um }));
    expect(search).toHaveBeenCalledWith(USER, "tea", 10);
  });

  it("returns an empty string without a user id", async () => {
    expect(await injectUserMemories(base({ userId: undefined, userMemory: await userMemory("x") }))).toBe("");
  });

  it("logs and skips a failed search", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const um = await userMemory("User likes tea");
    if (!um) throw new Error("fixture");
    vi.spyOn(um.store, "search").mockRejectedValue("boom");
    expect(await injectUserMemories(base({ userMemory: um }))).toBe("");
    expect(warn).toHaveBeenCalledWith(
      { error: "boom", agent: AGENT, user_id: USER },
      expect.stringContaining("User-memory search failed"),
    );
  });
});

describe("injectSemanticMemories", () => {
  it("searches with the raw input and the default limit of 5", async () => {
    const mem = await semantic("tea is good");
    const search = vi.spyOn(mem.store, "search");
    const out = await injectSemanticMemories(base({ guardedInput: "GUARDED", rawInput: "tea", semantic: mem }));
    expect(search).toHaveBeenCalledWith("tea", AGENT, 5);
    expect(out).toContain("\n\nRelevant context from previous sessions:\n- tea is good");
    expect(out).toContain("Use the `remember` tool");
  });

  it("leaves out the hint when curated tools are off", async () => {
    const mem = await semantic("tea is good", { curated_tools: false, max_memories: 2 });
    const search = vi.spyOn(mem.store, "search");
    const out = await injectSemanticMemories(base({ semantic: mem }));
    expect(search).toHaveBeenCalledWith("tea", AGENT, 2);
    expect(out).toBe("\n\nRelevant context from previous sessions:\n- tea is good");
  });

  it("does not search when inject_system is false", async () => {
    const mem = await semantic("tea", { inject_system: false });
    const search = vi.spyOn(mem.store, "search");
    expect(await injectSemanticMemories(base({ semantic: mem }))).toBe("");
    expect(search).not.toHaveBeenCalled();
  });

  it("does not need a user id", async () => {
    const out = await injectSemanticMemories(base({ userId: undefined, semantic: await semantic("tea") }));
    expect(out).toContain("- tea");
  });

  it("lets a failed search throw", async () => {
    const mem = await semantic("tea");
    vi.spyOn(mem.store, "search").mockRejectedValue(new Error("vector store down"));
    await expect(injectSemanticMemories(base({ semantic: mem }))).rejects.toThrow("vector store down");
  });
});

describe("injectMemories", () => {
  it("appends profile, then user memories, then semantic memories", async () => {
    const out = await injectMemories("BASE", base({
      userModel: await userModel("PROFILE"),
      userMemory: await userMemory("User likes tea"),
      semantic: await semantic("tea semantic", { curated_tools: false }),
    }));
    expect(out).toBe(
      "BASE" +
        "\n\nUser profile:\nPROFILE" +
        "\n\nWhat I remember about you:\n- User likes tea [importance: normal]" +
        "\n\nRelevant context from previous sessions:\n- tea semantic",
    );
  });

  it("returns the base unchanged when nothing is configured", async () => {
    expect(await injectMemories("BASE", base({}))).toBe("BASE");
  });
});
