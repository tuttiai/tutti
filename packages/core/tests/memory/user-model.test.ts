import { describe, it, expect, vi } from "vitest";

import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import {
  UserModelConsolidator,
  DEFAULT_EVERY_N_TURNS,
} from "../../src/memory/consolidator.js";
import {
  InMemoryUserModelStore,
  emptyProfile,
  type UserProfile,
} from "../../src/memory/user-model.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  LLMProvider,
} from "@tuttiai/types";

const USER = "user-alex";

/** Build a ChatResponse that answers a consolidation prompt with the given JSON body. */
function consolidationResponse(payload: unknown): ChatResponse {
  return {
    id: "resp-cons",
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 50, output_tokens: 25 },
  };
}

/** Build an LLMProvider whose `chat()` always returns `response`. */
function singleResponseProvider(response: ChatResponse): LLMProvider & {
  chat: ReturnType<typeof vi.fn>;
} {
  return {
    chat: vi.fn(async () => response),
    async *stream() {
      yield {
        type: "usage",
        usage: response.usage,
        stop_reason: response.stop_reason,
      };
    },
  };
}

/** Build an agent with `memory.user_model` configured. */
function userModelAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...simpleAgent,
    memory: {
      user_memory: { store: "memory", inject_limit: 10 },
      user_model: { enabled: true, every_n_turns: 5 },
      ...overrides.memory,
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  InMemoryUserModelStore                                              */
/* ------------------------------------------------------------------ */

describe("InMemoryUserModelStore", () => {
  it("returns null when the user has no profile", async () => {
    const store = new InMemoryUserModelStore();
    expect(await store.get(USER)).toBeNull();
  });

  it("round-trips a profile through upsert / get", async () => {
    const store = new InMemoryUserModelStore();
    const profile: UserProfile = {
      ...emptyProfile(USER),
      summary: "Senior backend engineer who prefers terse answers.",
      preferences: { communication_style: "terse, no emojis" },
      ongoing_projects: ["payments-api"],
      turn_count: 7,
      last_consolidated_turn: 5,
    };
    await store.upsert(profile);

    const fetched = await store.get(USER);
    expect(fetched).toEqual(profile);
  });

  it("isolates profiles by user_id", async () => {
    const store = new InMemoryUserModelStore();
    await store.upsert({ ...emptyProfile("a"), summary: "A" });
    await store.upsert({ ...emptyProfile("b"), summary: "B" });
    expect((await store.get("a"))?.summary).toBe("A");
    expect((await store.get("b"))?.summary).toBe("B");
  });

  it("returns a defensive clone — caller mutations don't leak", async () => {
    const store = new InMemoryUserModelStore();
    await store.upsert({
      ...emptyProfile(USER),
      summary: "original",
      preferences: { tone: "warm" },
      ongoing_projects: ["alpha"],
    });
    const fetched = (await store.get(USER))!;
    fetched.summary = "MUTATED";
    fetched.preferences.tone = "MUTATED";
    fetched.ongoing_projects.push("MUTATED");

    const refetched = (await store.get(USER))!;
    expect(refetched.summary).toBe("original");
    expect(refetched.preferences.tone).toBe("warm");
    expect(refetched.ongoing_projects).toEqual(["alpha"]);
  });

  it("delete is idempotent on unknown ids", async () => {
    const store = new InMemoryUserModelStore();
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  UserModelConsolidator                                              */
/* ------------------------------------------------------------------ */

describe("UserModelConsolidator", () => {
  it("creates a fresh profile on first consolidation", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "User prefers TypeScript", { importance: 3 });

    const provider = singleResponseProvider(
      consolidationResponse({
        summary: "Prefers strongly-typed languages.",
        preferences: { language: "typescript" },
        ongoing_projects: [],
      }),
    );

    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 3,
    });

    // 3 turns triggers (>= every_n_turns)
    await c.maybeConsolidate(USER, 3);

    const profile = await modelStore.get(USER);
    expect(profile).not.toBeNull();
    expect(profile!.summary).toBe("Prefers strongly-typed languages.");
    expect(profile!.preferences).toEqual({ language: "typescript" });
    expect(profile!.turn_count).toBe(3);
    expect(profile!.last_consolidated_turn).toBe(3);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("merges preferences across consolidations — accumulating shape", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "User prefers TypeScript");

    const responses = [
      consolidationResponse({
        summary: "Engineer.",
        preferences: { language: "typescript" },
        ongoing_projects: [],
      }),
      consolidationResponse({
        summary: "Engineer who prefers terse responses.",
        preferences: { language: "typescript", communication_style: "terse" },
        ongoing_projects: ["payments-api"],
      }),
    ];
    let i = 0;
    const provider: LLMProvider & { chat: ReturnType<typeof vi.fn> } = {
      chat: vi.fn(async () => responses[i++]!),
      async *stream() {
        /* not used */
      },
    };

    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 2,
    });

    await c.maybeConsolidate(USER, 2);
    await c.maybeConsolidate(USER, 2);

    const profile = (await modelStore.get(USER))!;
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(profile.preferences).toEqual({
      language: "typescript",
      communication_style: "terse",
    });
    expect(profile.ongoing_projects).toEqual(["payments-api"]);
    // The second pass should have rewritten the summary.
    expect(profile.summary).toContain("terse");
    expect(profile.turn_count).toBe(4);
    expect(profile.last_consolidated_turn).toBe(4);
  });

  it("only consolidates every N turns — not every call", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "anything");

    const provider = singleResponseProvider(
      consolidationResponse({
        summary: "s",
        preferences: {},
        ongoing_projects: [],
      }),
    );
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 5,
    });

    // 4 calls of 1 turn each → no consolidation yet
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).not.toHaveBeenCalled();

    // 5th turn triggers
    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // 4 more turns → still no second consolidation (last_consolidated_turn == 5)
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // 10th turn triggers second consolidation
    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("default cadence is 20 turns", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");
    const provider = singleResponseProvider(
      consolidationResponse({ summary: "s", preferences: {}, ongoing_projects: [] }),
    );
    const c = new UserModelConsolidator(modelStore, memoryStore, provider);

    await c.maybeConsolidate(USER, DEFAULT_EVERY_N_TURNS - 1);
    expect(provider.chat).not.toHaveBeenCalled();

    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("never throws — provider errors are caught and logged", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");
    const provider: LLMProvider = {
      chat: vi.fn(async () => {
        throw new Error("provider down");
      }),
      async *stream() {
        /* unused */
      },
    };

    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await expect(c.maybeConsolidate(USER, 1)).resolves.toBeUndefined();
    // Turn count was still bumped (we keep counting even when the LLM
    // call fails — otherwise we'd retry the same failing call every run).
    const profile = await modelStore.get(USER);
    expect(profile?.turn_count).toBe(1);
    expect(profile?.last_consolidated_turn).toBe(0);
    // No partial summary written.
    expect(profile?.summary).toBe("");
  });

  it("keeps the previous profile when JSON parsing fails", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");

    // Seed a previous profile.
    await modelStore.upsert({
      ...emptyProfile(USER),
      summary: "previous summary",
      preferences: { tone: "warm" },
      ongoing_projects: ["alpha"],
      turn_count: 0,
      last_consolidated_turn: 0,
    });

    // Provider returns garbage that won't parse as JSON.
    const provider = singleResponseProvider({
      id: "r",
      content: [{ type: "text", text: "not even close to JSON, really." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await c.maybeConsolidate(USER, 1);

    const profile = await modelStore.get(USER);
    expect(profile?.summary).toBe("previous summary");
    expect(profile?.preferences).toEqual({ tone: "warm" });
    expect(profile?.last_consolidated_turn).toBe(0);
    // Turn count still bumped.
    expect(profile?.turn_count).toBe(1);
  });

  it("keeps the previous profile when the JSON fails the schema", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");
    await modelStore.upsert({ ...emptyProfile(USER), summary: "before" });

    // Schema-invalid: ongoing_projects must be an array.
    const provider = singleResponseProvider(
      consolidationResponse({
        summary: "after",
        preferences: {},
        ongoing_projects: "not-an-array",
      }),
    );
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await c.maybeConsolidate(USER, 1);
    const profile = await modelStore.get(USER);
    expect(profile?.summary).toBe("before");
  });

  it("tolerates code-fenced JSON output", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");

    const fenced =
      "```json\n" +
      JSON.stringify({
        summary: "ok",
        preferences: {},
        ongoing_projects: [],
      }) +
      "\n```";
    const provider = singleResponseProvider({
      id: "r",
      content: [{ type: "text", text: fenced }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await c.maybeConsolidate(USER, 1);
    expect((await modelStore.get(USER))?.summary).toBe("ok");
  });

  it("skips the LLM call entirely on a brand-new user with no memories", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    const provider = singleResponseProvider(
      consolidationResponse({ summary: "s", preferences: {}, ongoing_projects: [] }),
    );
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await c.maybeConsolidate(USER, 1);
    expect(provider.chat).not.toHaveBeenCalled();
    // Turn count still bumped — we want the cadence to advance even
    // when there's nothing to summarise.
    expect((await modelStore.get(USER))?.turn_count).toBe(1);
  });

  it("emits user_model:consolidated on success", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "x");
    const provider = singleResponseProvider(
      consolidationResponse({ summary: "s", preferences: {}, ongoing_projects: [] }),
    );
    const events = new EventBus();
    const seen: Array<{ user_id: string; turn_count: number }> = [];
    events.on("user_model:consolidated", (e) =>
      seen.push({ user_id: e.user_id, turn_count: e.turn_count }),
    );

    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
      events,
    });
    await c.maybeConsolidate(USER, 1);

    expect(seen).toEqual([{ user_id: USER, turn_count: 1 }]);
  });

  it("ignores non-positive runTurnCount", async () => {
    const modelStore = new InMemoryUserModelStore();
    const memoryStore = new MemoryUserMemoryStore();
    const provider = singleResponseProvider(
      consolidationResponse({ summary: "x", preferences: {}, ongoing_projects: [] }),
    );
    const c = new UserModelConsolidator(modelStore, memoryStore, provider, {
      every_n_turns: 1,
    });

    await c.maybeConsolidate(USER, 0);
    await c.maybeConsolidate(USER, -3);
    expect(await modelStore.get(USER)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Runtime integration — system-prompt injection + post-run fire     */
/* ------------------------------------------------------------------ */

describe("user-model — runtime integration", () => {
  it("injects the profile into the system prompt before user-memory entries", async () => {
    const modelStore = new InMemoryUserModelStore();
    await modelStore.upsert({
      ...emptyProfile(USER),
      summary: "Senior backend engineer.",
      preferences: { communication_style: "terse" },
      ongoing_projects: ["payments-api"],
    });
    const memoryStore = new MemoryUserMemoryStore();
    await memoryStore.store(USER, "User name is Alex", { importance: 3 });

    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserMemoryStore("test-agent", memoryStore);
    runner.setUserModelStore("test-agent", modelStore);

    await runner.run(userModelAgent(), "User", undefined, { user_id: USER });

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock
      .calls[0]![0]!;
    const sys = req.system!;

    expect(sys).toContain("User profile:");
    expect(sys).toContain("Senior backend engineer.");
    expect(sys).toContain("Known preferences:");
    expect(sys).toContain("- communication_style: terse");
    expect(sys).toContain("Ongoing projects:");
    expect(sys).toContain("- payments-api");
    // Per-fact memory follows the profile block.
    const profileIdx = sys.indexOf("User profile:");
    const memoryIdx = sys.indexOf("What I remember about you:");
    expect(profileIdx).toBeGreaterThan(-1);
    expect(memoryIdx).toBeGreaterThan(profileIdx);
  });

  it("does NOT inject anything for a bootstrap-empty profile", async () => {
    const modelStore = new InMemoryUserModelStore();
    await modelStore.upsert(emptyProfile(USER));
    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserModelStore("test-agent", modelStore);

    await runner.run(
      userModelAgent({ memory: { user_model: { enabled: true } } }),
      "hello",
      undefined,
      { user_id: USER },
    );

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock
      .calls[0]![0]!;
    expect(req.system!).not.toContain("User profile:");
  });

  it("never crashes the agent run when the consolidator throws", async () => {
    const modelStore = new InMemoryUserModelStore();
    // Force store.upsert to reject — simulates an unreachable backend.
    modelStore.upsert = vi.fn(async () => {
      throw new Error("db down");
    });

    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserModelStore("test-agent", modelStore);

    // The run itself completes successfully — consolidator failure is
    // out-of-band.
    const result = await runner.run(
      userModelAgent(),
      "hello",
      undefined,
      { user_id: USER },
    );
    expect(result.output).toBe("hi");
  });

  it("user_model.enabled === false disables both injection and consolidation", async () => {
    const modelStore = new InMemoryUserModelStore();
    await modelStore.upsert({
      ...emptyProfile(USER),
      summary: "should not be injected",
    });

    const provider = createMockProvider([textResponse("hi")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    runner.setUserModelStore("test-agent", modelStore);

    await runner.run(
      userModelAgent({ memory: { user_model: { enabled: false } } }),
      "hello",
      undefined,
      { user_id: USER },
    );

    const req = (provider.chat as unknown as { mock: { calls: [ChatRequest][] } }).mock
      .calls[0]![0]!;
    expect(req.system!).not.toContain("User profile:");
  });
});
