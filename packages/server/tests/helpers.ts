/**
 * Shared test utilities for the server package.
 *
 * Builds a real {@link TuttiRuntime} backed by a mock LLM provider so
 * integration tests exercise the full path from HTTP → runtime → provider
 * without making real API calls.
 */

import { vi } from "vitest";
import { MemoryInterruptStore, TuttiRuntime } from "@tuttiai/core";
import type { InterruptStore } from "@tuttiai/core";
import type {
  AgentConfig,
  ChatResponse,
  LLMProvider,
  ScoreConfig,
  StreamChunk,
} from "@tuttiai/types";

import { createServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";

/* ------------------------------------------------------------------ */
/*  Mock provider                                                      */
/* ------------------------------------------------------------------ */

/** Builds a ChatResponse containing a single text block. */
export function textResponse(text: string): ChatResponse {
  return {
    id: `resp-${Math.random().toString(36).slice(2)}`,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/**
 * Creates a mock {@link LLMProvider} that returns canned responses in
 * order. `chat` and `stream` are vitest spies.
 */
export function createMockProvider(
  responses: ChatResponse[],
): LLMProvider {
  let idx = 0;
  const next = (): ChatResponse => {
    const r = responses[idx];
    if (!r) throw new Error("No more mock responses");
    idx++;
    return r;
  };

  return {
    chat: vi.fn(async () => next()),
    async *stream() {
      const r = next();
      for (const block of r.content) {
        if (block.type === "text") {
          yield { type: "text", text: block.text } as StreamChunk;
        }
      }
      yield { type: "usage", usage: r.usage, stop_reason: r.stop_reason } as StreamChunk;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Runtime + server builder                                           */
/* ------------------------------------------------------------------ */

const AGENT_NAME = "test-agent";
const API_KEY = "test-api-key";

export interface TestHarness {
  app: ReturnType<typeof createServer>;
  runtime: TuttiRuntime;
  interruptStore: InterruptStore | undefined;
}

/** Options for {@link buildTestServer}. */
export interface BuildTestServerOptions {
  /** Overrides merged into the final {@link ServerConfig}. */
  config?: Partial<ServerConfig>;
  /**
   * Attach an {@link InterruptStore} to the runtime. Pass `"memory"` to
   * auto-construct a {@link MemoryInterruptStore}. Pass a concrete
   * instance for custom setups.
   */
  interruptStore?: InterruptStore | "memory";
  /**
   * Full {@link AgentConfig} override for the test agent. Merged over
   * the default so callers can add `requireApproval`, voices, etc.
   */
  agent?: Partial<AgentConfig>;
}

/**
 * Build a fully-wired Fastify server with a mock-backed runtime.
 *
 * @param responses - Canned LLM responses the mock provider returns.
 * @param optionsOrLegacy - Either the new {@link BuildTestServerOptions}
 *   shape or the legacy `Partial<ServerConfig>` shape (kept so existing
 *   tests don't need updating).
 */
export async function buildTestServer(
  responses: ChatResponse[],
  optionsOrLegacy: BuildTestServerOptions | Partial<ServerConfig> = {},
): Promise<TestHarness> {
  const options: BuildTestServerOptions = isBuildOptions(optionsOrLegacy)
    ? optionsOrLegacy
    : { config: optionsOrLegacy };

  const provider = createMockProvider(responses);

  const baseAgent: AgentConfig = {
    name: AGENT_NAME,
    model: "test-model",
    system_prompt: "You are a test agent.",
    voices: [],
  };
  const agent: AgentConfig = { ...baseAgent, ...(options.agent ?? {}) };

  const score: ScoreConfig = {
    provider,
    agents: { [AGENT_NAME]: agent },
  };

  const interruptStore: InterruptStore | undefined =
    options.interruptStore === "memory"
      ? new MemoryInterruptStore()
      : options.interruptStore;

  const runtime = new TuttiRuntime(score, {
    ...(interruptStore !== undefined ? { interruptStore } : {}),
  });

  const app = await createServer({
    port: 0,
    host: "127.0.0.1",
    api_key: API_KEY,
    runtime,
    agent_name: AGENT_NAME,
    ...(options.config ?? {}),
  });

  return { app, runtime, interruptStore };
}

/** Structural check: do we have the new options shape or the legacy one? */
function isBuildOptions(v: unknown): v is BuildTestServerOptions {
  if (typeof v !== "object" || v === null) return false;
  return "config" in v || "interruptStore" in v || "agent" in v;
}

export { AGENT_NAME, API_KEY };
