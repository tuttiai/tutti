import { genAiSpanNaming } from "./genai-naming.js";
import { legacySpanNaming, type SpanNamingStrategy } from "./naming.js";

/**
 * Which span-naming convention an exporter emits.
 *
 * - `"legacy"` (the default): today's names (`agent.run`, `llm.completion`,
 *   `tool.call`) and attributes, unchanged.
 * - `"genai"`: the OpenTelemetry GenAI semantic conventions, see
 *   {@link genAiSpanNaming}. The upstream conventions are experimental.
 */
export type SpanNamingMode = "legacy" | "genai";

/** Show a rejected option value without echoing whole objects back. */
function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/**
 * Pick the strategy for a mode. `undefined` means the default, `"legacy"`.
 * Anything else throws rather than falling back silently.
 */
export function resolveSpanNaming(mode: unknown, owner: string): SpanNamingStrategy {
  if (mode === undefined || mode === "legacy") return legacySpanNaming;
  if (mode === "genai") return genAiSpanNaming;
  throw new Error(`${owner}: semconv must be "legacy" or "genai", got ${describeValue(mode)}`);
}
