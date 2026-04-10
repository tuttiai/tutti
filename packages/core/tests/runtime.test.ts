import { describe, it, expect } from "vitest";
import { TuttiRuntime } from "../src/runtime.js";
import {
  createSingleResponseProvider,
  textResponse,
  createMockProvider,
} from "./helpers/mock-provider.js";
import type { ScoreConfig, LLMProvider } from "@tuttiai/types";

function createScore(
  provider: LLMProvider,
  overrides?: Partial<ScoreConfig>,
): ScoreConfig {
  return {
    name: "test-score",
    provider,
    agents: {
      assistant: {
        name: "assistant",
        model: "test-model",
        system_prompt: "You are helpful.",
        voices: [],
      },
    },
    ...overrides,
  };
}

describe("TuttiRuntime", () => {
  it("runs a named agent and returns the result", async () => {
    const provider = createSingleResponseProvider("Hello!");
    const runtime = new TuttiRuntime(createScore(provider));

    const result = await runtime.run("assistant", "Hi");

    expect(result.output).toBe("Hello!");
    expect(result.turns).toBe(1);
    expect(result.session_id).toBeDefined();
  });

  it("throws for unknown agent names", async () => {
    const runtime = new TuttiRuntime(
      createScore(createSingleResponseProvider()),
    );

    await expect(
      runtime.run("nonexistent", "test"),
    ).rejects.toThrow('Agent "nonexistent" not found');
  });

  it("lists available agents in error message", async () => {
    const provider = createSingleResponseProvider();
    const score = createScore(provider, {
      agents: {
        alpha: {
          name: "alpha",
          model: "m",
          system_prompt: "p",
          voices: [],
        },
        beta: {
          name: "beta",
          model: "m",
          system_prompt: "p",
          voices: [],
        },
      },
    });
    const runtime = new TuttiRuntime(score);

    await expect(runtime.run("missing", "test")).rejects.toThrow(
      "Available agents: alpha, beta",
    );
  });

  it("applies default_model when agent has no model", async () => {
    const provider = createSingleResponseProvider();
    const score = createScore(provider, {
      default_model: "default-model-123",
      agents: {
        bot: {
          name: "bot",
          system_prompt: "hi",
          voices: [],
        },
      },
    });
    const runtime = new TuttiRuntime(score);

    await runtime.run("bot", "test");

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "default-model-123" }),
    );
  });

  it("falls back to claude-sonnet-4-20250514 when no model is set anywhere", async () => {
    const provider = createSingleResponseProvider();
    const score: ScoreConfig = {
      provider,
      agents: {
        bot: {
          name: "bot",
          system_prompt: "hi",
          voices: [],
        },
      },
    };
    const runtime = new TuttiRuntime(score);

    await runtime.run("bot", "test");

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-20250514" }),
    );
  });

  it("continues a session across multiple runs", async () => {
    const provider = createMockProvider([
      textResponse("first"),
      textResponse("second"),
    ]);
    const runtime = new TuttiRuntime(createScore(provider));

    const r1 = await runtime.run("assistant", "first");
    const r2 = await runtime.run("assistant", "second", r1.session_id);

    expect(r2.session_id).toBe(r1.session_id);
    expect(r2.messages.length).toBeGreaterThan(r1.messages.length);
  });

  it("retrieves a session after a run", async () => {
    const runtime = new TuttiRuntime(
      createScore(createSingleResponseProvider()),
    );

    const result = await runtime.run("assistant", "test");
    const session = runtime.getSession(result.session_id);

    expect(session).toBeDefined();
    expect(session!.id).toBe(result.session_id);
    expect(session!.messages.length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown session", () => {
    const runtime = new TuttiRuntime(
      createScore(createSingleResponseProvider()),
    );

    expect(runtime.getSession("nonexistent")).toBeUndefined();
  });

  it("exposes EventBus for subscribing to events", async () => {
    const runtime = new TuttiRuntime(
      createScore(createSingleResponseProvider()),
    );

    const events: string[] = [];
    runtime.events.onAny((e) => events.push(e.type));

    await runtime.run("assistant", "test");

    expect(events).toContain("agent:start");
    expect(events).toContain("agent:end");
  });
});
