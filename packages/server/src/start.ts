/**
 * Standalone entry point for running the Tutti server in Docker.
 *
 * Reads all configuration from environment variables — no score file needed.
 * One agent, optionally holding voices from `TUTTI_VOICES` (see
 * `start-env.ts`). For multi-agent setups, mount a score file and use the
 * library API (`createServer`) instead.
 */

import {
  TuttiRuntime,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  PermissionGuard,
  SecretsManager,
  createLogger,
} from "@tuttiai/core";
import type { AgentConfig, LLMProvider, ScoreConfig } from "@tuttiai/types";

import { createServer, DEFAULT_PORT } from "./index.js";
import { readStartAgentEnv } from "./start-env.js";
import { loadVoices } from "./voice-loader.js";

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

// Malformed voice configuration stops the process before it listens, so a
// deployment reports a failed start rather than an agent missing its tools.
const agentEnv = readStartAgentEnv((key) => SecretsManager.optional(key));
const voices = await loadVoices(agentEnv.voices);
const permissions = [...agentEnv.permissions];
for (const voice of voices) PermissionGuard.check(voice, permissions);

const agent: AgentConfig = {
  name: AGENT_NAME,
  model: MODEL,
  system_prompt: SYSTEM_PROMPT,
  voices,
  permissions,
  streaming: true,
};
if (agentEnv.max_turns !== undefined) agent.max_turns = agentEnv.max_turns;
if (agentEnv.max_tool_calls !== undefined) agent.max_tool_calls = agentEnv.max_tool_calls;
if (agentEnv.max_cost_usd !== undefined) agent.budget = { max_cost_usd: agentEnv.max_cost_usd };

const score: ScoreConfig = {
  name: "tutti-server",
  provider: buildProvider(),
  default_model: MODEL,
  agents: { [AGENT_NAME]: agent },
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
  {
    port: PORT,
    host: HOST,
    provider: PROVIDER,
    model: MODEL,
    agent: AGENT_NAME,
    // Names only: the options carry credentials.
    voices: voices.map((voice) => ({ name: voice.name, tools: voice.tools.length })),
    permissions,
  },
  "Tutti server started",
);
