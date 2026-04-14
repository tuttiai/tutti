/**
 * Standalone entry point for running the Tutti server in Docker.
 *
 * Reads all configuration from environment variables — no score file needed.
 * For multi-agent or voice-enabled setups, mount a score file and use the
 * library API (`createServer`) instead.
 */

import {
  TuttiRuntime,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  SecretsManager,
  createLogger,
} from "@tuttiai/core";
import type { LLMProvider, ScoreConfig } from "@tuttiai/types";

import { createServer, DEFAULT_PORT } from "./index.js";

const logger = createLogger("tutti-server");

const PROVIDER = SecretsManager.optional("TUTTI_PROVIDER") ?? "anthropic";
const MODEL = SecretsManager.optional("TUTTI_MODEL") ?? "claude-sonnet-4-20250514";
const SYSTEM_PROMPT =
  SecretsManager.optional("TUTTI_SYSTEM_PROMPT") ??
  "You are a helpful assistant.";
const AGENT_NAME = SecretsManager.optional("TUTTI_AGENT_NAME") ?? "assistant";
const PORT_STR = SecretsManager.optional("TUTTI_PORT") ?? String(DEFAULT_PORT);
const PORT = Number.parseInt(PORT_STR, 10);
const HOST = SecretsManager.optional("TUTTI_HOST") ?? "0.0.0.0";

function buildProvider(): LLMProvider {
  switch (PROVIDER) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "gemini":
      return new GeminiProvider();
    default:
      throw new Error(
        `Unknown provider "${PROVIDER}".\n` +
          "Set TUTTI_PROVIDER to one of: anthropic, openai, gemini",
      );
  }
}

const score: ScoreConfig = {
  name: "tutti-server",
  provider: buildProvider(),
  default_model: MODEL,
  agents: {
    [AGENT_NAME]: {
      name: AGENT_NAME,
      model: MODEL,
      system_prompt: SYSTEM_PROMPT,
      voices: [],
      streaming: true,
    },
  },
};

const runtime = new TuttiRuntime(score);

const app = await createServer({
  port: PORT,
  host: HOST,
  runtime,
  agent_name: AGENT_NAME,
});

await app.listen({ port: PORT, host: HOST });

logger.info(
  { port: PORT, host: HOST, provider: PROVIDER, model: MODEL, agent: AGENT_NAME },
  "Tutti server started",
);
