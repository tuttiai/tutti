/**
 * Shared test utilities for the server package.
 *
 * Builds a real {@link TuttiRuntime} backed by a mock LLM provider so
 * integration tests exercise the full path from HTTP → runtime → provider
 * without making real API calls.
 */

import { vi } from "vitest";
import { TuttiRuntime } from "@tuttiai/core";
import type {
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
}

/**
 * Build a fully-wired Fastify server with a mock-backed runtime.
 *
 * @param responses - Canned LLM responses the mock provider returns.
 * @param overrides - Extra {@link ServerConfig} fields to merge.
 */
export async function buildTestServer(
  responses: ChatResponse[],
  overrides: Partial<ServerConfig> = {},
): Promise<TestHarness> {
  const provider = createMockProvider(responses);

  const score: ScoreConfig = {
    provider,
    agents: {
      [AGENT_NAME]: {
        name: AGENT_NAME,
        model: "test-model",
        system_prompt: "You are a test agent.",
        voices: [],
      },
    },
  };

  const runtime = new TuttiRuntime(score);

  const app = await createServer({
    port: 0,
    host: "127.0.0.1",
    api_key: API_KEY,
    runtime,
    agent_name: AGENT_NAME,
    ...overrides,
  });

  return { app, runtime };
}

export { AGENT_NAME, API_KEY };
