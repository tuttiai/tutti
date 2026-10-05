/**
 * Context-window management: shortening a conversation before it is re-sent
 * to the model. See {@link compactContext}, driven by `AgentConfig.context`.
 */

export { compactContext } from "./compact.js";
export type { CompactDeps } from "./compact.js";
export { capText, capToolResults, estimateTokens, trimToolResults } from "./trim.js";
export { SUMMARY_HEADING, summariseHistory, summaryCut } from "./summarise.js";
