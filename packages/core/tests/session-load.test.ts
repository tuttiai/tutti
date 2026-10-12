/**
 * A run given a session id its store's `get` misses asks the store's
 * optional `load` before reporting the session as not found, so a session a
 * durable store kept across a restart can be continued.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ScoreConfig, Session, SessionStore } from "@tuttiai/types";

import { TuttiRuntime } from "../src/runtime.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";

const EARLIER: ChatMessage[] = [
  { role: "user", content: "My name is Ada." },
  { role: "assistant", content: "Hello Ada." },
];

/** A store whose `get` starts empty, as after a restart, and whose `load` reads "disk". */
function restartedStore(disk: Map<string, Session>): SessionStore & { load: ReturnType<typeof vi.fn> } {
  const memory = new InMemorySessionStore();
  return {
    create: (agent_name) => memory.create(agent_name),
    get: (id) => memory.get(id),
    update: (id, messages) => memory.update(id, messages),
    load: vi.fn(async (id: string) => {
      const session = disk.get(id);
      if (session) memory.save(session);
      return session;
    }),
  };
}

function score(provider: ScoreConfig["provider"]): ScoreConfig {
  return {
    name: "load",
    provider,
    agents: { assistant: { name: "assistant", model: "m", system_prompt: "s", voices: [] } },
  };
}

function savedSession(): Session {
  const at = new Date(0);
  return { id: "kept", agent_name: "assistant", messages: [...EARLIER], created_at: at, updated_at: at };
}

describe("AgentRunner session resolution", () => {
  it("continues a session the store loads when get misses", async () => {
    const provider = createMockProvider([textResponse("Your name is Ada.")]);
    const store = restartedStore(new Map([["kept", savedSession()]]));
    const runtime = new TuttiRuntime(score(provider), { sessionStore: store });

    const result = await runtime.run("assistant", "What is my name?", "kept");

    expect(store.load).toHaveBeenCalledWith("kept");
    expect(result.session_id).toBe("kept");
    // Safe: the provider's chat is only ever called with a ChatRequest.
    const sent = provider.chat.mock.calls[0]?.[0] as { messages: ChatMessage[] } | undefined;
    expect(sent?.messages.slice(0, 2)).toEqual(EARLIER);
    expect(runtime.getSession("kept")?.messages).toHaveLength(4);
  });

  it("does not call load when get finds the session", async () => {
    const provider = createMockProvider([textResponse("one"), textResponse("two")]);
    const store = restartedStore(new Map());
    const runtime = new TuttiRuntime(score(provider), { sessionStore: store });

    const first = await runtime.run("assistant", "hi");
    await runtime.run("assistant", "again", first.session_id);

    expect(store.load).not.toHaveBeenCalled();
  });

  it("still reports a session neither get nor load finds", async () => {
    const store = restartedStore(new Map());
    const runtime = new TuttiRuntime(score(createMockProvider([])), { sessionStore: store });

    await expect(runtime.run("assistant", "hi", "gone")).rejects.toThrow("Session not found: gone");
  });

  it("reports a missing session from a store without load", async () => {
    const runtime = new TuttiRuntime(score(createMockProvider([])));

    await expect(runtime.run("assistant", "hi", "gone")).rejects.toThrow("Session not found: gone");
  });
});

describe("TuttiRuntime.loadSession", () => {
  it("finds a session through load when get misses", async () => {
    const runtime = new TuttiRuntime(score(createMockProvider([])), {
      sessionStore: restartedStore(new Map([["kept", savedSession()]])),
    });

    expect(runtime.getSession("kept")).toBeUndefined();
    expect((await runtime.loadSession("kept"))?.messages).toEqual(EARLIER);
  });

  it("answers from get for a store without load", async () => {
    const runtime = new TuttiRuntime(score(createMockProvider([])));

    expect(await runtime.loadSession("missing")).toBeUndefined();
  });
});
