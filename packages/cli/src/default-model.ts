/**
 * The model the CLI falls back to when neither an agent nor its score
 * names one. Used by `tutti-ai schedule` and `tutti-ai schedules trigger`.
 */

import type { AgentConfig } from "@tuttiai/core";

/** Model id the CLI uses when neither the agent nor the score sets one. */
export const CLI_DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * Resolve the model an agent runs on, without mutating the agent.
 *
 * @param agent - The agent config from the score.
 * @param defaultModel - The score's `default_model`, if it has one.
 * @returns The agent itself when it names a model; otherwise a copy
 *   whose model is `defaultModel`, or {@link CLI_DEFAULT_MODEL}.
 */
export function withDefaultModel(agent: AgentConfig, defaultModel?: string): AgentConfig {
  if (agent.model) return agent;
  return { ...agent, model: defaultModel ?? CLI_DEFAULT_MODEL };
}
