import { describe, it, expect, vi } from "vitest";
import {
  TuttiError,
  ScoreValidationError,
  AgentNotFoundError,
  PermissionError,
  BudgetExceededError,
  ToolTimeoutError,
  ProviderError,
  AuthenticationError,
  RateLimitError,
  ContextWindowError,
  VoiceError,
  PathTraversalError,
  UrlValidationError,
} from "../../src/errors.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";
import type { ChatResponse, LLMProvider, StreamChunk } from "@tuttiai/types";

// ── Error properties ───────────────────────────────────────────

describe("TuttiError", () => {
  it("has code, message, and context", () => {
    const err = new TuttiError("TEST_CODE", "test message", { key: "val" });

    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.context).toEqual({ key: "val" });
    expect(err.name).toBe("TuttiError");
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults context to empty object", () => {
    const err = new TuttiError("X", "msg");
    expect(err.context).toEqual({});
  });
});

describe("ScoreValidationError", () => {
  it("has code SCORE_INVALID and correct name", () => {
    const err = new ScoreValidationError("bad field", { field: "name", value: 42 });

    expect(err.code).toBe("SCORE_INVALID");
    expect(err.name).toBe("ScoreValidationError");
    expect(err.context).toEqual({ field: "name", value: 42 });
    expect(err).toBeInstanceOf(TuttiError);
  });
});

describe("AgentNotFoundError", () => {
  it("has code AGENT_NOT_FOUND with agent_id and available list", () => {
    const err = new AgentNotFoundError("ghost", ["assistant", "coder"]);

    expect(err.code).toBe("AGENT_NOT_FOUND");
    expect(err.name).toBe("AgentNotFoundError");
    expect(err.context.agent_id).toBe("ghost");
    expect(err.context.available).toEqual(["assistant", "coder"]);
    expect(err.message).toContain('"ghost"');
    expect(err.message).toContain("assistant, coder");
  });
});

describe("PermissionError", () => {
  it("has code PERMISSION_DENIED with voice, required, granted", () => {
    const err = new PermissionError("fs-voice", ["filesystem", "network"], ["network"]);

    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.name).toBe("PermissionError");
    expect(err.context.voice).toBe("fs-voice");
    expect(err.context.required).toEqual(["filesystem", "network"]);
    expect(err.context.granted).toEqual(["network"]);
    expect(err.message).toContain("filesystem");
  });
});

describe("BudgetExceededError", () => {
  it("has code BUDGET_EXCEEDED with tokens and cost", () => {
    const err = new BudgetExceededError(50000, 0.15, "max_tokens: 40000");

    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.name).toBe("BudgetExceededError");
    expect(err.context.tokens).toBe(50000);
    expect(err.context.cost_usd).toBe(0.15);
    expect(err.context.limit).toBe("max_tokens: 40000");
  });
});

describe("ToolTimeoutError", () => {
  it("has code TOOL_TIMEOUT with tool name and timeout", () => {
    const err = new ToolTimeoutError("search_files", 30000);

    expect(err.code).toBe("TOOL_TIMEOUT");
    expect(err.name).toBe("ToolTimeoutError");
    expect(err.context.tool).toBe("search_files");
    expect(err.context.timeout_ms).toBe(30000);
    expect(err.message).toContain("search_files");
    expect(err.message).toContain("30000ms");
  });
});

// ── Provider error hierarchy ───────────────────────────────────

describe("ProviderError", () => {
  it("has code PROVIDER_ERROR", () => {
    const err = new ProviderError("API failed", { provider: "anthropic", status: 500 });

    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.name).toBe("ProviderError");
    expect(err.context.provider).toBe("anthropic");
    expect(err.context.status).toBe(500);
    expect(err).toBeInstanceOf(TuttiError);
  });
});

describe("AuthenticationError", () => {
  it("has code AUTH_ERROR and extends ProviderError", () => {
    const err = new AuthenticationError("openai");

    expect(err.code).toBe("AUTH_ERROR");
    expect(err.name).toBe("AuthenticationError");
    expect(err.context.provider).toBe("openai");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(TuttiError);
  });
});

describe("RateLimitError", () => {
  it("has code RATE_LIMIT with retryAfter", () => {
    const err = new RateLimitError("anthropic", 30);

    expect(err.code).toBe("RATE_LIMIT");
    expect(err.name).toBe("RateLimitError");
    expect(err.retryAfter).toBe(30);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("30s");
  });

  it("works without retryAfter", () => {
    const err = new RateLimitError("openai");

    expect(err.retryAfter).toBeUndefined();
    expect(err.code).toBe("RATE_LIMIT");
  });
});

describe("ContextWindowError", () => {
  it("has code CONTEXT_WINDOW with maxTokens", () => {
    const err = new ContextWindowError("anthropic", 200000);

    expect(err.code).toBe("CONTEXT_WINDOW");
    expect(err.name).toBe("ContextWindowError");
    expect(err.maxTokens).toBe(200000);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("200,000");
  });
});

// ── Voice error hierarchy ──────────────────────────────────────

describe("VoiceError", () => {
  it("has code VOICE_ERROR with voice context", () => {
    const err = new VoiceError("setup failed", { voice: "mcp", tool: "connect" });

    expect(err.code).toBe("VOICE_ERROR");
    expect(err.name).toBe("VoiceError");
    expect(err.context.voice).toBe("mcp");
    expect(err.context.tool).toBe("connect");
    expect(err).toBeInstanceOf(TuttiError);
  });
});

describe("PathTraversalError", () => {
  it("has code PATH_TRAVERSAL with path", () => {
    const err = new PathTraversalError("../../etc/passwd");

    expect(err.code).toBe("PATH_TRAVERSAL");
    expect(err.name).toBe("PathTraversalError");
    expect(err.context.path).toBe("../../etc/passwd");
    expect(err).toBeInstanceOf(VoiceError);
  });
});

describe("UrlValidationError", () => {
  it("has code URL_BLOCKED with url", () => {
    const err = new UrlValidationError("javascript:alert(1)");

    expect(err.code).toBe("URL_BLOCKED");
    expect(err.name).toBe("UrlValidationError");
    expect(err.context.url).toBe("javascript:alert(1)");
    expect(err).toBeInstanceOf(VoiceError);
  });
});

// ── instanceof checks across the hierarchy ─────────────────────

describe("instanceof chains", () => {
  it("AuthenticationError is ProviderError is TuttiError is Error", () => {
    const err = new AuthenticationError("test");
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(TuttiError);
    expect(err).toBeInstanceOf(Error);
  });

  it("PathTraversalError is VoiceError is TuttiError", () => {
    const err = new PathTraversalError("/etc/shadow");
    expect(err).toBeInstanceOf(PathTraversalError);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err).toBeInstanceOf(TuttiError);
  });

  it("ScoreValidationError is NOT a ProviderError", () => {
    const err = new ScoreValidationError("bad");
    expect(err).not.toBeInstanceOf(ProviderError);
  });
});

// ── Retry logic ────────────────────────────────────────────────

describe("Retry logic in AgentRunner", () => {
  it("retries on ProviderError and succeeds on second attempt", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new ProviderError("Temporary failure", { provider: "test" });
        }
        return textResponse("Recovered");
      }),
      async *stream() {
        yield { type: "text", text: "x" } as StreamChunk;
        yield { type: "usage", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" } as StreamChunk;
      },
    };
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(simpleAgent, "hello");

    expect(result.output).toBe("Recovered");
    expect(callCount).toBe(2);
  });

  it("does NOT retry on ScoreValidationError", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      chat: vi.fn(async () => {
        callCount++;
        throw new ScoreValidationError("bad score");
      }),
      async *stream() { /* noop */ },
    };
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    await expect(runner.run(simpleAgent, "hello")).rejects.toThrow(ScoreValidationError);
    expect(callCount).toBe(1);
  });

  it("gives up after 3 retries on ProviderError", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      chat: vi.fn(async () => {
        callCount++;
        throw new ProviderError("Always fails", { provider: "test" });
      }),
      async *stream() { /* noop */ },
    };
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    await expect(runner.run(simpleAgent, "hello")).rejects.toThrow(ProviderError);
    expect(callCount).toBe(3);
  });
});
