import {
  SpanKind as OTelSpanKind,
  SpanStatusCode,
  TraceFlags,
  type HrTime,
  type SpanContext,
  type SpanStatus as OTelSpanStatus,
} from "@opentelemetry/api";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import type { SpanNamingStrategy } from "../semconv/naming.js";
import type { TuttiSpan } from "../types.js";

/** Resource attribution applied to every exported batch. */
const RESOURCE: Resource = resourceFromAttributes({
  "service.name": "tutti",
  "telemetry.sdk.name": "@tuttiai/telemetry",
  "telemetry.sdk.version": "0.1.0",
  "telemetry.sdk.language": "nodejs",
});

/** Convert a JS Date into the OTel `[seconds, nanos]` HrTime tuple. */
function dateToHrTime(d: Date): HrTime {
  const ms = d.getTime();
  const seconds = Math.trunc(ms / 1000);
  // `ms % 1000` is cheaper and more precise than `ms - seconds * 1000`,
  // which drifts once `ms` nears the 53-bit safe-integer range.
  const nanos = Math.round((ms % 1000) * 1_000_000);
  return [seconds, nanos];
}

/** Milliseconds into an HrTime duration, with the same modulo trick. */
function durationToHrTime(durationMs: number): HrTime {
  const durationSec = Math.trunc(durationMs / 1000);
  const durationNano = Math.round((durationMs % 1000) * 1_000_000);
  return [durationSec, durationNano];
}

/**
 * UUID v4 to 32-char OTLP trace id. UUIDs are 16 bytes (32 hex + 4 dashes);
 * dropping the dashes lands on exactly the byte-count OTLP wants.
 */
function uuidToTraceId(uuid: string): string {
  return uuid.replace(/-/g, "");
}

/**
 * UUID v4 to 16-char OTLP span id. OTLP span ids are 8 bytes (16 hex chars);
 * we take the first 16 hex chars of the UUID. This keeps span ids deterministic
 * (so OTel traces nest correctly via parent_span_id) and the collision rate is
 * negligible per-trace.
 */
function uuidToSpanId(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 16);
}

/** A sampled span context for one span id within the trace. */
function sampledContext(traceId: string, spanUuid: string): SpanContext {
  return { traceId, spanId: uuidToSpanId(spanUuid), traceFlags: TraceFlags.SAMPLED };
}

/** Tutti status to OTel status, keeping the already-redacted error message. */
function toOTelStatus(span: TuttiSpan): OTelSpanStatus {
  const code =
    span.status === "ok"
      ? SpanStatusCode.OK
      : span.status === "error"
        ? SpanStatusCode.ERROR
        : SpanStatusCode.UNSET;
  return span.error?.message !== undefined
    ? { code, message: span.error.message }
    : { code };
}

/**
 * Construct the minimal {@link ReadableSpan} that the JSON serialiser needs.
 * The exported name and attributes come from `naming`; ids, times and
 * status are the same in every naming mode.
 */
export function tuttiSpanToReadableSpan(
  span: TuttiSpan,
  naming: SpanNamingStrategy,
): ReadableSpan {
  const traceId = uuidToTraceId(span.trace_id);
  const ctx = sampledContext(traceId, span.span_id);
  const startTime = dateToHrTime(span.started_at);
  const { name, attributes } = naming(span);
  return {
    name,
    kind: OTelSpanKind.INTERNAL,
    spanContext: () => ctx,
    ...(span.parent_span_id !== undefined
      ? { parentSpanContext: sampledContext(traceId, span.parent_span_id) }
      : {}),
    startTime,
    endTime: span.ended_at ? dateToHrTime(span.ended_at) : startTime,
    duration: durationToHrTime(span.duration_ms ?? 0),
    status: toOTelStatus(span),
    attributes,
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
