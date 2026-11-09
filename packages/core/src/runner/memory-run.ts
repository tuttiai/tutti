import type {
  AgentConfig,
  AgentMemoryConfig,
  ChatMessage,
  ChatRequest,
  Tool,
  ToolContext,
} from "@tuttiai/types";
import type { EventBus } from "../event-bus.js";
import { logger } from "../logger.js";
import type { SemanticMemoryStore } from "../memory/semantic.js";
import {
  MemoryEnforcer,
  createMemoryHelpers,
  createMemoryTools,
  DEFAULT_MAX_ENTRIES_PER_AGENT,
} from "../memory/curated.js";
import type { StoreOptions, UserMemoryStore } from "../memory/user/types.js";
import type { UserMemoryWiring } from "./memory-registry.js";
import { parseInferredMemories } from "./memory-format.js";

/**
 * Semantic memory resolved once per run. The system-prompt injection,
 * `ToolContext.memory` and the curated agent tools all route through
 * the same `enforcer`, so per-agent cap, LRU eviction and `memory:*`
 * events fire exactly once per logical operation.
 */
export interface SemanticRunMemory {
  cfg: AgentMemoryConfig;
  store: SemanticMemoryStore;
  enforcer: MemoryEnforcer;
}

/** The per-run memory a tool call's context is given helpers for. */
export interface RunMemoryHelpers {
  userId?: string;
  userMemory?: UserMemoryWiring;
  semantic?: SemanticRunMemory;
}

/** What auto-infer needs to extract and store memories after a run. */
export interface InferUserMemoriesInput {
  agentName: string;
  model: string | undefined;
  userId: string;
  messages: ChatMessage[];
  store: UserMemoryStore;
}

/** Sends one chat request and resolves to the reply's text. */
export type CompleteText = (request: ChatRequest) => Promise<string>;

const EXTRACTION_PROMPT =
  "Extract 0–3 new factual memories about the user from this conversation. " +
  "Return a JSON array of strings. Each string must be a single sentence " +
  "starting with 'User'. Return [] if nothing new was learned.";

/**
 * Resolve the agent's semantic memory config and store for one run.
 * A custom `agent.memory.semantic.store` wins over the runner's shared
 * store. Returns `undefined` when semantic memory is disabled or no
 * store is available.
 */
export function resolveSemanticMemory(
  agent: AgentConfig,
  fallbackStore: SemanticMemoryStore | undefined,
  events: EventBus,
): SemanticRunMemory | undefined {
  const cfg = agent.memory?.semantic;
  if (!cfg?.enabled) return undefined;
  const store = cfg.store ?? fallbackStore;
  if (!store) return undefined;
  const maxEntries = cfg.max_entries_per_agent ?? DEFAULT_MAX_ENTRIES_PER_AGENT;
  const enforcer = new MemoryEnforcer(store, agent.name, maxEntries, events);
  return { cfg, store, enforcer };
}

/**
 * The curated `remember` / `recall` / `forget` agent tools, or none when
 * semantic memory is off or `curated_tools` is `false`. They are not a
 * Voice: voices declare permissions and have setup and teardown hooks
 * that do not apply to in-process memory.
 */
export function curatedToolsFor(semantic: SemanticRunMemory | undefined): Tool[] {
  if (!semantic || semantic.cfg.curated_tools === false) return [];
  return createMemoryTools({ enforcer: semantic.enforcer });
}

/**
 * Attach the memory helpers to a tool call's context. `user_memory` is
 * bound to the run's user id, so tool code does not pass it, and
 * defaults to importance 3 (high) since an explicit `remember()` call
 * reflects deliberate intent. `memory` shares the run's enforcer.
 */
export function attachMemoryHelpers(ctx: ToolContext, run: RunMemoryHelpers): void {
  const { userId, userMemory, semantic } = run;
  if (userId && userMemory) {
    const store = userMemory.store;
    ctx.user_memory = {
      remember: async (content, options) => {
        const stored = await store.store(userId, content, {
          source: "explicit",
          importance: options?.importance ?? 3,
          ...(options?.tags !== undefined ? { tags: options.tags } : {}),
          ...(options?.expires_at !== undefined ? { expires_at: options.expires_at } : {}),
        });
        return { id: stored.id };
      },
    };
  }
  if (semantic) {
    ctx.memory = createMemoryHelpers(semantic.enforcer);
  }
}

/**
 * Ask the model for new facts about the user in the last few turns.
 * Returns `undefined` when the call fails, after logging it.
 */
export async function requestInferredFacts(
  complete: CompleteText,
  input: InferUserMemoriesInput,
): Promise<string[] | undefined> {
  // Last 5 turns is about the last 10 messages (one user and one
  // assistant per turn). The LLM does not need exact framing.
  const recent = input.messages.slice(-10);
  if (recent.length === 0) return undefined;
  let text: string;
  try {
    text = await complete({ model: input.model, system: EXTRACTION_PROMPT, messages: recent });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), agent: input.agentName },
      "User-memory auto-infer LLM call failed — skipping inference",
    );
    return undefined;
  }
  return parseInferredMemories(text.trim());
}

/**
 * Store each fact as an `inferred` memory of normal importance. A fact
 * that fails to store is logged and skipped; the rest are still stored.
 */
export async function storeInferredFacts(facts: string[], input: InferUserMemoriesInput): Promise<void> {
  for (const content of facts) {
    try {
      const opts: StoreOptions = { source: "inferred", importance: 2 };
      await input.store.store(input.userId, content, opts);
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          agent: input.agentName,
          user_id: input.userId,
        },
        "User-memory auto-infer store failed for one fact",
      );
    }
  }
}

/**
 * Send the last few turns to the LLM with an extraction prompt and store
 * any returned facts as `inferred` memories. Best effort: parse failures,
 * malformed responses and provider errors are logged and swallowed, so
 * auto-infer never aborts the wider run.
 */
export async function inferUserMemories(complete: CompleteText, input: InferUserMemoriesInput): Promise<void> {
  const facts = await requestInferredFacts(complete, input);
  if (!facts || facts.length === 0) return;
  await storeInferredFacts(facts, input);
}
