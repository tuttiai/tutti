import { afterEach, describe, it, expect, vi } from "vitest";
import type { ChatMessage, ChatRequest } from "@tuttiai/types";

import {
  inferUserMemories,
  requestInferredFacts,
  storeInferredFacts,
  type InferUserMemoriesInput,
} from "../../src/runner/memory-run.js";
import { logger } from "../../src/logger.js";
import { MemoryUserMemoryStore } from "../../src/memory/user/memory-store.js";
import { simpleAgent } from "../helpers/mock-provider.js";

const USER = "u1";

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
