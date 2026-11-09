import { logger } from "../logger.js";
import type { UserMemory } from "../memory/user/types.js";
import type { UserMemoryWiring, UserModelWiring } from "./memory-registry.js";
import type { SemanticRunMemory } from "./memory-run.js";
import {
  formatSemanticMemories,
  formatUserMemories,
  renderProfileForPrompt,
} from "./memory-format.js";

/** What the runner knows at run start that the memory injectors need. */
export interface MemoryPromptInput {
  agentName: string;
  userId?: string;
  /** The input after the input guardrail; user memories are searched with it. */
  guardedInput: string;
  /** The run's raw input; semantic memories are searched with it. */
  rawInput: string;
  userMemory?: UserMemoryWiring;
  userModel?: UserModelWiring;
  semantic?: SemanticRunMemory;
}

/**
 * The user's dialectic profile as a prompt block, or `""`. A failed
 * profile load is logged and skipped.
 */
export async function injectProfile(input: MemoryPromptInput): Promise<string> {
  const { userId, userModel } = input;
  if (!userId || !userModel) return "";
  try {
    const profile = await userModel.store.get(userId);
    return profile ? renderProfileForPrompt(profile) : "";
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), agent: input.agentName, user_id: userId },
      "User-model load failed — continuing without injected profile",
    );
    return "";
  }
}

/**
 * The user's most relevant memories as a prompt block, or `""`. A failed
 * search is logged and the run continues with no injected memories.
 */
export async function injectUserMemories(input: MemoryPromptInput): Promise<string> {
  const { userId, userMemory } = input;
  if (!userId || !userMemory) return "";
  const limit = userMemory.cfg.inject_limit ?? 10;
  let memories: UserMemory[] = [];
  try {
    memories = await userMemory.store.search(userId, input.guardedInput, limit);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), agent: input.agentName, user_id: userId },
      "User-memory search failed — continuing without injected memories",
    );
  }
  return formatUserMemories(memories);
}

/**
 * Relevant semantic memories as a prompt block, or `""`. Unlike the user
 * memory injectors, a failed search is not caught and fails the run.
 */
export async function injectSemanticMemories(input: MemoryPromptInput): Promise<string> {
  const { semantic } = input;
  if (!semantic || semantic.cfg.inject_system === false) return "";
  const maxMemories = semantic.cfg.max_memories ?? 5;
  const memories = await semantic.store.search(input.rawInput, input.agentName, maxMemories);
  return formatSemanticMemories(memories, semantic.cfg.curated_tools !== false);
}

/**
 * Append the run's memories to the base system prompt, once before the
 * first turn so the prompt stays the same from turn to turn and the
 * provider's prompt cache can serve it. The profile comes first so the
 * agent sees the holistic picture before the specific facts, then the
 * user memories, then the semantic memories.
 */
export async function injectMemories(base: string, input: MemoryPromptInput): Promise<string> {
  let prompt = base;
  prompt += await injectProfile(input);
  prompt += await injectUserMemories(input);
  prompt += await injectSemanticMemories(input);
  return prompt;
}
