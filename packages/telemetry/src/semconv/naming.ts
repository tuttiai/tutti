import type { AttributeValue, Attributes } from "@opentelemetry/api";

import type { TuttiSpan, TuttiSpanAttributes } from "../types.js";

/** The span name and attributes an exporter sends for one {@link TuttiSpan}. */
export interface ExportedSpanNaming {
  /** Span name as the backend will show it. */
  readonly name: string;
  /** OpenTelemetry attributes, already converted to values OTLP accepts. */
  readonly attributes: Attributes;
}

/**
 * Maps one closed {@link TuttiSpan} to the name and attributes it is
 * exported with. Applied at export time only: the in-process span keeps its
 * own name, which cost accounting relies on. Pure, and must never throw.
 */
export type SpanNamingStrategy = (span: TuttiSpan) => ExportedSpanNaming;

/** Serialise an arbitrary attribute value to something OTel will accept. */
export function toAttributeValue(v: unknown): AttributeValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  // Arrays of primitives are accepted; everything else gets stringified.
  if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) return v;
  if (Array.isArray(v) && v.every((x): x is number => typeof x === "number")) return v;
  if (Array.isArray(v) && v.every((x): x is boolean => typeof x === "boolean")) return v;
  try {
    return JSON.stringify(v);
  } catch {
    // Fallback when JSON.stringify throws (circular refs, BigInts); avoid
    // the default "[object Object]" from String(v), which the linter, and
    // a human looking at a span attribute, would find equally useless.
    return Object.prototype.toString.call(v);
  }
}

/** Copy every set attribute across and add `tutti.kind`. */
export function tuttiAttrsToOTel(
  attrs: TuttiSpanAttributes,
  span: TuttiSpan,
): Attributes {
  const entries: Array<[string, AttributeValue]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    const av = toAttributeValue(v);
    if (av !== undefined) entries.push([k, av]);
  }
  // Surface the tutti-specific `kind` so backends can filter without
  // having to map our names to OTel SpanKind (we only emit INTERNAL).
  entries.push(["tutti.kind", span.kind]);
  return Object.fromEntries(entries);
}

/**
 * The default strategy: the span's own name (`agent.run`, `llm.completion`,
 * `tool.call`, ...) and every attribute as set, plus `tutti.kind`.
 */
export const legacySpanNaming: SpanNamingStrategy = (span) => ({
  name: span.name,
  attributes: tuttiAttrsToOTel(span.attributes, span),
});
