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
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

import type { TuttiSpan, TuttiSpanAttributes } from "../types.js";
import type { SpanExporter } from "./types.js";

/** Default flush cadence when no spans hit the size threshold. */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** Default batch size threshold that triggers an immediate flush. */
const DEFAULT_BATCH_SIZE = 100;
/** Maximum POST attempts per batch before the batch is dropped. */
const MAX_RETRIES = 3;
/** Resource attribution applied to every exported batch. */
const RESOURCE: Resource = resourceFromAttributes({
  "service.name": "tutti",
  "telemetry.sdk.name": "@tuttiai/telemetry",
  "telemetry.sdk.version": "0.1.0",
  "telemetry.sdk.language": "nodejs",
});

/** Construction options for {@link OTLPExporter}. */
export interface OTLPExporterOptions {
  /**
   * Full URL of the OTLP/HTTP traces endpoint. Standard collectors expose
   * this at `http://<host>:4318/v1/traces`. Vendors (Jaeger, Datadog,
   * Honeycomb) use their own hostnames and require a header — see {@link headers}.
   */
  endpoint: string;
  /** Headers added to every POST — typically auth tokens (`x-honeycomb-team`, etc.). */
  headers?: Record<string, string>;
  /** Override the default 5,000 ms flush cadence. Mainly useful in tests. */
  flushIntervalMs?: number;
  /** Override the default 100-span batch size. */
  maxBatchSize?: number;
  /**
   * Optional logger for exporter failures. The exporter never throws;
   * callers that want visibility into dropped batches pass a logger here.
   */
  onError?: (err: unknown, attempt: number) => void;
}

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
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    const av = toAttributeValue(v);
    if (av !== undefined) out[k] = av;
  }
  // Surface the tutti-specific `kind` so backends can filter without
  // having to map our names to OTel SpanKind (we only emit INTERNAL).
  out["tutti.kind"] = span.kind;
  return out;
}

/** Construct the minimal {@link ReadableSpan} that the JSON serialiser needs. */
function tuttiSpanToReadableSpan(span: TuttiSpan): ReadableSpan {
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

/* ------------------------------------------------------------------ */
/*  Exporter                                                           */
/* ------------------------------------------------------------------ */

/**
 * Buffered, retry-aware OTLP/HTTP JSON exporter.
 *
 * Closed spans are queued in an in-memory buffer that flushes when:
 *   1. the buffer hits {@link OTLPExporterOptions.maxBatchSize} (default 100), or
 *   2. {@link OTLPExporterOptions.flushIntervalMs} elapses (default 5 s).
 *
 * Failed POSTs are retried up to {@link MAX_RETRIES} times with exponential
 * backoff. After the last failure the batch is silently dropped — exporter
 * failures must never bubble into the agent loop. Pass `onError` to surface
 * drops to your own logger.
 *
 * Running spans (status `"running"`) are ignored — only ended spans carry
 * meaningful duration / status / attribute data.
 */
export class OTLPExporter implements SpanExporter {
  private buffer: TuttiSpan[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(private readonly opts: OTLPExporterOptions) {
    const intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    // Don't keep the event loop alive just for the flush timer.
    this.timer.unref?.();
  }

  export(span: TuttiSpan): void {
    if (this.shuttingDown) return;
    if (span.status === "running") return;
    this.buffer.push(span);
    const limit = this.opts.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    if (this.buffer.length >= limit) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    // Coalesce concurrent flush triggers so we never POST the same batch
    // twice when both the timer and a size-based trigger fire together.
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    this.inFlight = this.send(batch).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  private async send(batch: TuttiSpan[]): Promise<void> {
    const payloadBytes = JsonTraceSerializer.serializeRequest(
      batch.map(tuttiSpanToReadableSpan),
    );
    if (!payloadBytes) return; // serialiser produced nothing — drop silently
    // Decode to string: JsonTraceSerializer's output is UTF-8 JSON, and
    // passing a string body avoids @types/node's stricter undici BodyInit
    // typing (which rejects raw Uint8Array in some setups).
    const payload = new TextDecoder().decode(payloadBytes);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(this.opts.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.opts.headers,
          },
          body: payload,
        });
        if (res.ok) return;
        // 4xx is permanent — retry buys nothing. Drop and surface.
        if (res.status >= 400 && res.status < 500) {
          this.opts.onError?.(
            new Error(`OTLP export rejected: ${res.status} ${res.statusText}`),
            attempt,
          );
          return;
        }
        throw new Error(`OTLP export failed: ${res.status} ${res.statusText}`);
      } catch (err) {
        this.opts.onError?.(err, attempt);
        if (attempt >= MAX_RETRIES) return;
        // Exponential backoff: 1s, 2s, 4s. Capped by attempt count = 3.
        const delayMs = 1000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}
