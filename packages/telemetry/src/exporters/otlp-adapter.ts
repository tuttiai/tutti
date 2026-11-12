import {
  SpanKind as OTelSpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type HrTime,
  type SpanContext,
} from "@opentelemetry/api";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import type { TuttiSpan, TuttiSpanAttributes } from "../types.js";

/** Resource attribution applied to every exported batch. */
const RESOURCE: Resource = resourceFromAttributes({
  "service.name": "tutti",
  "telemetry.sdk.name": "@tuttiai/telemetry",
  "telemetry.sdk.version": "0.1.0",
  "telemetry.sdk.language": "nodejs",
});
/* ------------------------------------------------------------------ */
/*  TuttiSpan → ReadableSpan adapter                                   */
/* ------------------------------------------------------------------ */

/** Convert a JS Date into the OTel `[seconds, nanos]` HrTime tuple. */
function dateToHrTime(d: Date): HrTime {
  const ms = d.getTime();
  const seconds = Math.trunc(ms / 1000);
  // `ms % 1000` — cheaper and more precise than `ms - seconds * 1000`,
  // which drifts once `ms` nears the 53-bit safe-integer range.
  const nanos = Math.round((ms % 1000) * 1_000_000);
  return [seconds, nanos];
}

/**
 * UUID v4 → 32-char OTLP trace id. UUIDs are 16 bytes (32 hex + 4 dashes);
 * dropping the dashes lands on exactly the byte-count OTLP wants.
 */
function uuidToTraceId(uuid: string): string {
  return uuid.replace(/-/g, "");
}

/**
 * UUID v4 → 16-char OTLP span id. OTLP span ids are 8 bytes (16 hex chars);
 * we take the first 16 hex chars of the UUID. This keeps span ids deterministic
 * (so OTel traces nest correctly via parent_span_id) and the collision rate is
 * negligible per-trace.
 */
function uuidToSpanId(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 16);
}

/** Serialise an arbitrary attribute value to something OTel will accept. */
function toAttributeValue(v: unknown): AttributeValue | undefined {
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
    // the default "[object Object]" from String(v) which the linter — and
    // a human looking at a span attribute — would find equally useless.
    return Object.prototype.toString.call(v);
  }
}

function tuttiAttrsToOTel(
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

/** Construct the minimal {@link ReadableSpan} that the JSON serialiser needs. */
export function tuttiSpanToReadableSpan(span: TuttiSpan): ReadableSpan {
  const traceId = uuidToTraceId(span.trace_id);
  const spanId = uuidToSpanId(span.span_id);
  const startTime = dateToHrTime(span.started_at);
  const endTime = span.ended_at ? dateToHrTime(span.ended_at) : startTime;
  const durationMs = span.duration_ms ?? 0;
  const durationSec = Math.trunc(durationMs / 1000);
  // Same modulo trick as dateToHrTime — avoid subtractive precision loss.
  const durationNano = Math.round((durationMs % 1000) * 1_000_000);

  const ctx: SpanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
  };

  const parentCtx: SpanContext | undefined =
    span.parent_span_id !== undefined
      ? {
          traceId,
          spanId: uuidToSpanId(span.parent_span_id),
          traceFlags: TraceFlags.SAMPLED,
        }
      : undefined;

  const code =
    span.status === "ok"
      ? SpanStatusCode.OK
      : span.status === "error"
        ? SpanStatusCode.ERROR
        : SpanStatusCode.UNSET;

  return {
    name: span.name,
    kind: OTelSpanKind.INTERNAL,
    spanContext: () => ctx,
    ...(parentCtx !== undefined ? { parentSpanContext: parentCtx } : {}),
    startTime,
    endTime,
    duration: [durationSec, durationNano],
    status:
      span.error?.message !== undefined
        ? { code, message: span.error.message }
        : { code },
    attributes: tuttiAttrsToOTel(span.attributes, span),
    links: [],
    events: [],
    ended: span.status !== "running",
    resource: RESOURCE,
    instrumentationScope: { name: "@tuttiai/telemetry", version: "0.1.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}
