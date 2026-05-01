/**
 * `@tuttiai/router` — smart model router for Tutti.
 *
 * Routes each LLM request to the cheapest configured tier that can handle
 * it, using a pluggable {@link Classifier} strategy.
 */

export * from "./types.js";
export { HeuristicClassifier } from "./heuristic.js";
export { LLMClassifier } from "./llm-classifier.js";
export { SmartProvider, type ChatOverride } from "./smart-provider.js";
