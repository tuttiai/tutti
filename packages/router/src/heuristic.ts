/**
 * Zero-cost rule-based classifier with destructive-tool awareness.
 *
 * The {@link HeuristicClassifier} inspects the latest user message plus a
 * handful of context signals (policy, prior stop reason, destructive tool
 * count) and picks a {@link Tier} without any extra LLM call. It's the
 * default classifier strategy because it adds no latency and no cost.
 */

import type { ChatRequest } from "@tuttiai/types";
import type { Classifier, ClassifierContext, Tier } from "./types.js";

const CODE_FENCE = /```[\s\S]*?```/;
const COMPLEX_KEYWORDS =
  /\b(refactor|architect|design|prove|theorem|optimi[sz]e|debug|reason|step[\s-]?by[\s-]?step)\b/i;
const SIMPLE_KEYWORDS =
  /\b(summari[sz]e|translate|format|extract|classify|tag|rewrite|tldr)\b/i;

/**
 * Default classifier — picks a tier from regex / length / tool-count signals
 * combined with the routing policy and a destructive-tool premium.
 */
export class HeuristicClassifier implements Classifier {
  /**
   * Pick a {@link Tier} for `req`. The decision is fully synchronous, but
   * the public surface returns a `Promise` to satisfy the {@link Classifier}
   * contract shared with async classifiers (e.g. {@link LLMClassifier}).
   *
   * @param req - The chat request being routed.
   * @param ctx - Routing-only context (policy, prior stop reason, destructive count).
   */
  classify(req: ChatRequest, ctx: ClassifierContext): Promise<Tier> {
    return Promise.resolve(this.decide(req, ctx));
  }

  private decide(req: ChatRequest, ctx: ClassifierContext): Tier {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser);
    const charCount = text.length;
    const tokenEstimate = Math.ceil(charCount / 4);
    const hasCode = CODE_FENCE.test(text);
    const isComplex = COMPLEX_KEYWORDS.test(text);
    const isSimple = SIMPLE_KEYWORDS.test(text);
    const toolCount = req.tools?.length ?? 0;
    const turn = ctx.turn_index ?? 0;

    // Destructive-tool detection — agents with destructive tools loaded
    // pay a small quality premium because mistakes are hard to undo.
    const destructiveCount =
      ctx.destructive_tool_count ??
      (req.tools?.filter((t) => (t as { destructive?: boolean }).destructive === true).length ?? 0);
    const hasDestructive = destructiveCount > 0;

    // Forced upgrade: previous turn ran out of room
    if (ctx.previous_stop_reason === "max_tokens") {
      return ctx.policy === "cost-optimised" ? "medium" : "large";
    }

    // Quality-first short-circuit
    if (ctx.policy === "quality-first") return "large";

    // Destructive-tool bias (applies before the policy branches diverge).
    // Cost-optimised still gets to keep simple tasks on small even with one
    // destructive tool — but multiple destructive tools always lift to medium.
    if (hasDestructive && ctx.policy === "balanced") return "large";
    if (destructiveCount >= 2 && ctx.policy === "cost-optimised") return "medium";

    // Cost-optimised aggressively prefers small
    if (ctx.policy === "cost-optimised") {
      if (isSimple && !hasCode && tokenEstimate < 500 && toolCount < 4) return "small";
      if (isComplex || hasCode || tokenEstimate > 4000) return "medium";
      return "small";
    }

    // Balanced
    if (isComplex || (hasCode && tokenEstimate > 1500) || tokenEstimate > 8000) return "large";
    if (hasCode || tokenEstimate > 1000 || toolCount >= 4 || turn >= 3) return "medium";
    if (isSimple && tokenEstimate < 300) return "small";
    return "medium";
  }
}
