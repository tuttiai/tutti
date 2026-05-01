/**
 * Public types for `@tuttiai/router` — the smart model router.
 *
 * The router exposes an {@link LLMProvider} (added in a later prompt) that
 * delegates each request to one of several configured {@link ModelTier}s
 * based on a {@link Classifier}'s decision.
 */

import type { LLMProvider, ChatRequest } from "@tuttiai/types";

/** Capability/cost tier a request can be routed to. */
export type Tier = "small" | "medium" | "large" | "fallback";

/** A single model the router can route to, plus its cost envelope. */
export interface ModelTier {
  tier: Tier;
  provider: LLMProvider;
  model: string;
  /** Max input tokens this tier should handle. Defaults to model's known context. */
  max_context?: number;
  /** Optional override of the per-million pricing — falls back to the global PRICING table in @tuttiai/core/token-budget. */
  pricing?: { input_per_m: number; output_per_m: number };
}

/** Classifier strategy used to pick a tier per request. */
export type ClassifierStrategy = "heuristic" | "llm" | "embedding";

/** High-level routing policy that biases tier selection. */
export type RoutingPolicy = "cost-optimised" | "quality-first" | "balanced";

/** Configuration for the {@link LLMProvider} surfaced by `@tuttiai/router`. */
export interface SmartProviderConfig {
  tiers: ModelTier[];
  /** Classifier strategy. Defaults to `'heuristic'`. */
  classifier?: ClassifierStrategy;
  /** Routing policy. Defaults to `'cost-optimised'`. */
  policy?: RoutingPolicy;
  max_cost_per_run_usd?: number;
  /** When true, escalate one tier on tool_use stop_reason or max_tokens hit. Default true. */
  auto_escalate?: boolean;
  /** Provider used for the 'llm' classifier. Defaults to the 'small' tier. */
  classifier_provider?: { provider: LLMProvider; model: string };
  /** Decision callbacks — wired by AgentRunner so events reach the EventBus. */
  on_decision?: (decision: RoutingDecision) => void;
  on_fallback?: (info: { from_model: string; to_model: string; error: string }) => void;
}

/** Result of a single routing decision; emitted via {@link SmartProviderConfig.on_decision}. */
export interface RoutingDecision {
  tier: Tier;
  model: string;
  reason: string;
  classifier: ClassifierStrategy;
  estimated_input_tokens: number;
  estimated_cost_usd: number;
}

/**
 * Context passed to a {@link Classifier} alongside the {@link ChatRequest}.
 *
 * Includes routing-only signals (policy, remaining budget, prior stop reason)
 * that should not bleed into the request itself.
 */
export interface ClassifierContext {
  tiers: ModelTier[];
  policy: RoutingPolicy;
  agent_role?: "orchestrator" | "specialist";
  voices_loaded?: string[];
  turn_index?: number;
  remaining_budget_usd?: number;
  previous_stop_reason?: string;
  /**
   * Pre-computed count of destructive tools loaded for the agent.
   * When provided, takes precedence over inspecting `req.tools`.
   */
  destructive_tool_count?: number;
}

/** Strategy interface for picking a {@link Tier} for a given request. */
export interface Classifier {
  classify(req: ChatRequest, ctx: ClassifierContext): Promise<Tier>;
}
