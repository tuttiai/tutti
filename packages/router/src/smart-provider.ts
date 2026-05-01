/**
 * `SmartProvider` — the meta-provider that wraps several configured
 * {@link ModelTier}s and dispatches each call to whichever tier the
 * configured {@link Classifier} picks.
 *
 * Implements {@link LLMProvider} so it can be dropped into any agent
 * configuration that accepts a provider, including `defineScore`.
 */

import { PRICING } from "@tuttiai/core";
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamChunk,
} from "@tuttiai/types";
import { HeuristicClassifier } from "./heuristic.js";
import { LLMClassifier } from "./llm-classifier.js";
import type {
  Classifier,
  ClassifierContext,
  ModelTier,
  RoutingDecision,
  SmartProviderConfig,
  Tier,
} from "./types.js";

const TIER_ORDER: Tier[] = ["small", "medium", "large", "fallback"];

/** Per-call override that lets callers (e.g. AgentRunner) bypass classification. */
export interface ChatOverride {
  force_tier?: Tier;
  force_reason?: string;
}

/** Routes each request to the cheapest configured tier that can handle it. */
export class SmartProvider implements LLMProvider {
  /** Stable identifier — useful in logs and OTel attributes. */
  readonly name = "smart-router";
  /** Public so AgentRunner can attach event callbacks without breaking encapsulation. */
  public config: SmartProviderConfig;
  private classifier: Classifier;
  private lastDecision?: RoutingDecision;

  constructor(config: SmartProviderConfig) {
    if (!config.tiers.length) throw new Error("SmartProvider requires at least one tier");
    this.config = config;
    this.classifier = this.buildClassifier();
  }

  /** Last routing decision — useful for tests, EventBus emission, and OTel spans. */
  getLastDecision(): RoutingDecision | undefined {
    return this.lastDecision;
  }

  /** Classify without running the call. Used by AgentRunner for budget previews. */
  async previewDecision(
    request: ChatRequest,
    ctx?: Partial<ClassifierContext>,
  ): Promise<RoutingDecision> {
    const fullCtx: ClassifierContext = {
      tiers: this.config.tiers,
      policy: this.config.policy ?? "cost-optimised",
      ...ctx,
    };
    const tier = await this.classifier.classify(request, fullCtx);
    const chosen = this.pickTier(tier);
    return this.recordDecision(chosen, request, "preview");
  }

  /** Pick a tier, dispatch the chat call, and emit decision/fallback events. */
  async chat(request: ChatRequest, override?: ChatOverride): Promise<ChatResponse> {
    const { chosen, reason } = await this.resolveTier(request, override);
    const decision = this.recordDecision(chosen, request, reason);
    this.lastDecision = decision;
    this.config.on_decision?.(decision);

    try {
      return await chosen.provider.chat({ ...request, model: chosen.model });
    } catch (err) {
      const fallback = this.config.tiers.find((t) => t.tier === "fallback");
      if (fallback && fallback !== chosen) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.config.on_fallback?.({
          from_model: chosen.model,
          to_model: fallback.model,
          error: errorMsg,
        });
        this.lastDecision = this.recordDecision(fallback, request, `fallback after error: ${errorMsg}`);
        this.config.on_decision?.(this.lastDecision);
        return await fallback.provider.chat({ ...request, model: fallback.model });
      }
      throw err;
    }
  }

  /**
   * Streaming counterpart of {@link chat}. Delegates to the chosen tier's
   * `stream`. Note: streaming has no fallback path because chunks may
   * already have been yielded to the consumer when the underlying call
   * fails.
   */
  async *stream(request: ChatRequest, override?: ChatOverride): AsyncGenerator<StreamChunk> {
    const { chosen, reason } = await this.resolveTier(request, override);
    const decision = this.recordDecision(chosen, request, reason);
    this.lastDecision = decision;
    this.config.on_decision?.(decision);
    yield* chosen.provider.stream({ ...request, model: chosen.model });
  }

  private async resolveTier(
    request: ChatRequest,
    override: ChatOverride | undefined,
  ): Promise<{ chosen: ModelTier; reason: string }> {
    if (override?.force_tier) {
      return {
        chosen: this.pickTier(override.force_tier),
        reason: override.force_reason ?? "forced",
      };
    }
    const ctx: ClassifierContext = {
      tiers: this.config.tiers,
      policy: this.config.policy ?? "cost-optimised",
    };
    const tier = await this.classifier.classify(request, ctx);
    return { chosen: this.pickTier(tier), reason: "classified" };
  }

  private buildClassifier(): Classifier {
    const strat = this.config.classifier ?? "heuristic";
    if (strat === "heuristic") return new HeuristicClassifier();
    if (strat === "llm") {
      const c = this.config.classifier_provider;
      if (c) return new LLMClassifier(c.provider, c.model);
      const small = this.config.tiers.find((t) => t.tier === "small");
      if (!small) throw new Error("LLM classifier requires either classifier_provider or a 'small' tier");
      return new LLMClassifier(small.provider, small.model);
    }
    // 'embedding' classifier deferred to a follow-up release.
    throw new Error(`classifier '${strat}' not yet implemented — use 'heuristic' or 'llm'`);
  }

  private pickTier(target: Tier): ModelTier {
    const exact = this.config.tiers.find((t) => t.tier === target);
    if (exact) return exact;
    // Walk down the order to the next configured tier.
    const idx = TIER_ORDER.indexOf(target);
    for (let i = idx; i < TIER_ORDER.length; i++) {
      const candidate = TIER_ORDER[i];
      const t = this.config.tiers.find((x) => x.tier === candidate);
      if (t) return t;
    }
    // Constructor guarantees at least one tier exists.
    const first = this.config.tiers[0];
    if (!first) throw new Error("SmartProvider requires at least one tier");
    return first;
  }

  private recordDecision(tier: ModelTier, req: ChatRequest, reason: string): RoutingDecision {
    const inputTokens = this.estimateInputTokens(req);
    const { input, output } = this.resolveRates(tier);
    return {
      tier: tier.tier,
      model: tier.model,
      reason,
      classifier: this.config.classifier ?? "heuristic",
      estimated_input_tokens: inputTokens,
      estimated_cost_usd: (inputTokens / 1_000_000) * input + (1024 / 1_000_000) * output,
    };
  }

  private resolveRates(tier: ModelTier): { input: number; output: number } {
    if (tier.pricing) {
      return { input: tier.pricing.input_per_m, output: tier.pricing.output_per_m };
    }
    const fromTable = PRICING[tier.model];
    if (fromTable) return fromTable;
    return { input: 1, output: 5 };
  }

  private estimateInputTokens(req: ChatRequest): number {
    const txt = req.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" ");
    return Math.ceil(txt.length / 4);
  }
}
