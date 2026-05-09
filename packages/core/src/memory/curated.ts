/**
 * Agent-curated semantic memory tools.
 *
 * Exposes `remember` / `recall` / `forget` as Tools the model itself
 * can call across turns, alongside the system-prompt injection that
 * has been part of semantic memory since v0.21. Both surfaces — the
 * legacy `ToolContext.memory` helpers and the new agent-callable
 * tools — route through a shared {@link MemoryEnforcer} so per-agent
 * cap enforcement, true-LRU eviction, and event emission happen
 * exactly once.
 *
 * The tools are NOT a {@link Voice}: voices declare permissions and
 * have setup/teardown hooks that don't apply to in-process memory.
 * The runtime injects them directly into the agent's tool list.
 */

import { z } from "zod";
import type {
  SemanticMemoryStore,
  SemanticSearchOptions,
  Tool,
  ToolMemoryHelpers,
  ToolRememberOptions,
  ToolResult,
} from "@tuttiai/types";
import type { EventBus } from "../event-bus.js";

/** Default per-agent cap when {@link CuratedMemoryOptions.maxEntriesPerAgent} is omitted. */
export const DEFAULT_MAX_ENTRIES_PER_AGENT = 1000;

/**
 * Shared enforcer wrapping a {@link SemanticMemoryStore}. Both the
 * curated agent tools and the legacy {@link ToolMemoryHelpers}
 * delegate to an instance of this class so the cap, LRU eviction, and
 * `memory:*` events fire exactly once per logical operation.
 */
export class MemoryEnforcer {
  constructor(
    private readonly store: SemanticMemoryStore,
    private readonly agentName: string,
    private readonly maxEntries: number,
    private readonly events?: EventBus,
  ) {}

  async write(
    content: string,
    options?: ToolRememberOptions,
  ): Promise<{ id: string }> {
    await this.evictIfOverCap();

    const source = options?.source ?? "system";
    const tags = options?.tags;
    const stored = await this.store.add({
      agent_name: this.agentName,
      content,
      metadata: options?.metadata ?? {},
      ...(source !== undefined ? { source } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });

    this.events?.emit({
      type: "memory:write",
      agent_name: this.agentName,
      entry_id: stored.id,
      source,
      ...(tags !== undefined ? { tags } : {}),
    });
    return { id: stored.id };
  }

  async read(
    query: string,
    limit?: number,
    options?: SemanticSearchOptions,
  ): Promise<{ id: string; content: string }[]> {
    const entries = await this.store.search(
      query,
      this.agentName,
      limit,
      options,
    );
    this.events?.emit({
      type: "memory:read",
      agent_name: this.agentName,
      query,
      result_count: entries.length,
    });
    return entries.map((e) => ({ id: e.id, content: e.content }));
  }

  async del(
    id: string,
    reason: "explicit" | "lru_eviction" = "explicit",
  ): Promise<void> {
    await this.store.delete(id);
    this.events?.emit({
      type: "memory:delete",
      agent_name: this.agentName,
      entry_id: id,
      reason,
    });
  }

  /**
   * Drop the least-recently-used entry for this agent when the next
   * write would exceed the cap. `last_accessed_at` is set on add and
   * bumped on every search hit, giving a true LRU view; entries that
   * never had it set fall back to `created_at`.
   */
  private async evictIfOverCap(): Promise<void> {
    const all = await this.store.listByAgent(this.agentName);
    if (all.length < this.maxEntries) return;

    const sorted = [...all].sort((a, b) => {
      const ax = (a.last_accessed_at ?? a.created_at).getTime();
      const bx = (b.last_accessed_at ?? b.created_at).getTime();
      return ax - bx;
    });
    const victim = sorted[0];
    if (!victim) return;
    await this.del(victim.id, "lru_eviction");
  }
}

/**
 * Build {@link ToolMemoryHelpers} that route every call through a
 * shared {@link MemoryEnforcer}. The runtime attaches the result to
 * `ToolContext.memory` for user-defined tools to use directly.
 */
export function createMemoryHelpers(
  enforcer: MemoryEnforcer,
): ToolMemoryHelpers {
  return {
    remember: (content, options) =>
      enforcer.write(content, normaliseRememberOptions(options)),
    recall: (query, limit) => enforcer.read(query, limit),
    forget: (id) => enforcer.del(id, "explicit"),
  };
}

/**
 * Either pass `enforcer` directly (to share a single enforcer across
 * `ctx.memory` helpers and the agent-callable tools) or pass
 * `{ store, agentName, ... }` and let the factory build one. The
 * runtime takes the first form so per-agent cap, LRU, and `memory:*`
 * events fire exactly once per logical operation across both surfaces.
 */
export type CuratedMemoryOptions =
  | { enforcer: MemoryEnforcer }
  | {
      store: SemanticMemoryStore;
      agentName: string;
      /** Per-agent cap; defaults to {@link DEFAULT_MAX_ENTRIES_PER_AGENT}. */
      maxEntriesPerAgent?: number;
      /** Wire `memory:*` events through this bus. Optional in tests. */
      events?: EventBus;
    };

const RememberSchema = z.object({
  content: z.string().min(1, "content is required"),
  tags: z.array(z.string().min(1)).optional(),
});

const RecallSchema = z.object({
  query: z.string().min(1, "query is required"),
  limit: z.number().int().positive().max(50).optional(),
});

const ForgetSchema = z.object({
  id: z.string().min(1, "id is required"),
});

/**
 * Build the three agent-callable memory tools — `remember`, `recall`,
 * `forget`. Returns a fresh array on every call; the runtime appends
 * it to `agent.voices.flatMap(v => v.tools)` when
 * `agent.memory.semantic.curated_tools !== false`.
 */
export function createMemoryTools(opts: CuratedMemoryOptions): Tool[] {
  const enforcer =
    "enforcer" in opts
      ? opts.enforcer
      : new MemoryEnforcer(
          opts.store,
          opts.agentName,
          opts.maxEntriesPerAgent ?? DEFAULT_MAX_ENTRIES_PER_AGENT,
          opts.events,
        );

  const remember: Tool<z.infer<typeof RememberSchema>> = {
    name: "remember",
    description:
      "Store a fact, preference, or context the user has shared that you should remember across sessions. Use when: the user states a preference, names a person/project, mentions ongoing work, or asks you to remember something. Pass concise, self-contained sentences — not paraphrases of the conversation. Optional `tags` group related entries (e.g. ['preference','formatting']).",
    parameters: RememberSchema,
    async execute(input): Promise<ToolResult> {
      const { id } = await enforcer.write(input.content, {
        source: "agent",
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      });
      return { content: `Remembered (id=${id}).` };
    },
  };

  const recall: Tool<z.infer<typeof RecallSchema>> = {
    name: "recall",
    description:
      "Search your long-term memory for entries relevant to a query. Use before answering questions about prior sessions, the user's preferences, or named entities. Returns up to `limit` matches sorted by relevance (default 5).",
    parameters: RecallSchema,
    async execute(input): Promise<ToolResult> {
      const hits = await enforcer.read(input.query, input.limit);
      if (hits.length === 0) return { content: "No matching memories." };
      const lines = hits.map((h) => `- (${h.id}) ${h.content}`).join("\n");
      return { content: `Recalled ${hits.length} entr${hits.length === 1 ? "y" : "ies"}:\n${lines}` };
    },
  };

  const forget: Tool<z.infer<typeof ForgetSchema>> = {
    name: "forget",
    description:
      "Delete a specific memory entry by id. Use when the user retracts something previously stored, or when a fact is no longer accurate. Get the id from a prior `recall` result.",
    parameters: ForgetSchema,
    destructive: true,
    async execute(input): Promise<ToolResult> {
      await enforcer.del(input.id, "explicit");
      return { content: `Forgot ${input.id}.` };
    },
  };

  return [remember, recall, forget];
}

function normaliseRememberOptions(
  raw: ToolRememberOptions | Record<string, unknown> | undefined,
): ToolRememberOptions | undefined {
  if (raw === undefined) return undefined;
  // The legacy form was `remember(content, metadata)`. Detect by the
  // absence of any options-bag key — if so, treat the whole value as
  // metadata. New callers pass `{ source, tags, metadata }`.
  if ("source" in raw || "tags" in raw || "metadata" in raw) {
    return raw as ToolRememberOptions;
  }
  return { metadata: raw as Record<string, unknown> };
}
