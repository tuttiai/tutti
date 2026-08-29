/**
 * Compose the base system prompt for a run.
 *
 * Three things are layered onto the agent's own `system_prompt`, in this
 * order: structured-output instructions, the user's consolidated profile, and
 * the specific memories recalled for this input. The order is deliberate — the
 * agent sees the holistic picture before the individual facts.
 *
 * Every layer is independently optional and independently non-fatal. A memory
 * backend that is down degrades the prompt; it never fails the run.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentConfig, AgentUserMemoryConfig } from "@tuttiai/types";
import type { UserMemory, UserMemoryStore } from "../memory/user/types.js";
import type { UserModelStore } from "../memory/user-model.js";
import type { UserModelConsolidator } from "../memory/consolidator.js";
import { logger } from "../logger.js";
import { importanceLabel, renderProfileForPrompt } from "./helpers.js";

/** Default number of user memories injected when the agent sets no limit. */
const DEFAULT_INJECT_LIMIT = 10;

/** The per-agent user-memory store and its config, as resolved by the runner. */
export type ResolvedUserMemory = { store: UserMemoryStore; cfg: AgentUserMemoryConfig };

/** The per-agent user-model store and its consolidator. */
export type ResolvedUserModel = { store: UserModelStore; consolidator: UserModelConsolidator };

/** Inputs to {@link composeSystemPrompt} beyond the agent itself. */
export interface SystemPromptInputs {
  /** The user this run is attributed to, when known. */
  userId: string | undefined;
  /** The guardrail-processed input, used as the memory search query. */
  guardedInput: string;
  /** The agent's user-memory store, when configured. */
  userMemory: ResolvedUserMemory | undefined;
  /** The agent's user-model store, when configured. */
  userModel: ResolvedUserModel | undefined;
}

/** The composed prompt and the memories that went into it. */
export interface ComposedSystemPrompt {
  /** The system prompt every turn of this run starts from. */
  baseSystemPrompt: string;
  /** The memories injected, retained so the run can report them. */
  injectedUserMemories: UserMemory[];
}

/**
 * Build the base system prompt a run's turns start from.
 *
 * Memories are injected **once**, before the first turn, into the base prompt
 * so they persist across every subsequent turn rather than being re-searched.
 * The search uses the raw input so the most contextually relevant memories
 * surface.
 *
 * @param agent - The agent about to run.
 * @param inputs - The user, the guarded input, and the resolved memory stores.
 * @returns The composed prompt and the injected memories.
 */
export async function composeSystemPrompt(
  agent: AgentConfig,
  inputs: SystemPromptInputs,
): Promise<ComposedSystemPrompt> {
  const { userId, guardedInput, userMemory, userModel } = inputs;

  let baseSystemPrompt = agent.system_prompt;

  if (agent.outputSchema) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance
    const outputJsonSchema = zodToJsonSchema(agent.outputSchema, { target: "openApi3" });
    baseSystemPrompt +=
      "\n\nYou must respond with a valid JSON object matching this schema: " +
      JSON.stringify(outputJsonSchema) +
      ". No other text.";
  }

  // Inject the user's dialectic profile (if any) BEFORE per-fact
  // user memories so the agent sees the holistic picture first, then
  // the specific facts. Both injectors are independently no-op when
  // their respective configs are absent.
  if (userId && userModel) {
    try {
      const profile = await userModel.store.get(userId);
      if (profile) {
        baseSystemPrompt += renderProfileForPrompt(profile);
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), agent: agent.name, user_id: userId },
        "User-model load failed — continuing without injected profile",
      );
    }
  }

  let injectedUserMemories: UserMemory[] = [];
  if (userId && userMemory) {
    const limit = userMemory.cfg.inject_limit ?? DEFAULT_INJECT_LIMIT;
    try {
      injectedUserMemories = await userMemory.store.search(userId, guardedInput, limit);
    } catch (err) {
      // User-memory failures are non-fatal — log and continue with
      // an empty memory set rather than aborting the whole run.
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), agent: agent.name, user_id: userId },
        "User-memory search failed — continuing without injected memories",
      );
    }
    if (injectedUserMemories.length > 0) {
      baseSystemPrompt += "\n\nWhat I remember about you:\n" +
        injectedUserMemories
          .map((m) => "- " + m.content + " [importance: " + importanceLabel(m.importance) + "]")
          .join("\n");
    }
  }

  return { baseSystemPrompt, injectedUserMemories };
}
