import { randomUUID } from "node:crypto";

import type {
  SpanKind,
  SpanStatus,
  TuttiSpan,
  TuttiSpanAttributes,
  TuttiSpanError,
} from "./types.js";

/**
 * Default cap on the number of spans kept in the in-process ring buffer.
 * Once exceeded, the oldest span is evicted on every new write.
 */
export const DEFAULT_MAX_SPANS = 1000;

/**
 * Callback invoked on every span lifecycle event (open and close). The same
 * span instance is delivered on both events — inspect {@link TuttiSpan.status}
 * to distinguish.
 */
export type SpanSubscriber = (span: TuttiSpan) => void;

/**
 * Construction options for {@link TuttiTracer}.
 */
export interface TuttiTracerOptions {
  /**
   * Maximum number of spans retained in the ring buffer. Defaults to
   * {@link DEFAULT_MAX_SPANS}. When exceeded, the oldest span (and any
   * lookup by its id) is evicted.
   */
  max_spans?: number;
}

/**
 * In-process tracer that owns a bounded ring buffer of spans and a set of
 * live subscribers. Designed for the Tutti runtime to call from the agent
 * loop, tool executor, LLM provider, and guardrail layer.
 *
 * The tracer is intentionally synchronous and lock-free — all callers run
 * on the Node.js event loop, and span writes are cheap.
 *
 * @example
 * const tracer = new TuttiTracer();
 * const span = tracer.startSpan("agent.run", "agent", { agent_id: "a" });
 * try {
 *   // ...do work...
 *   tracer.endSpan(span.span_id, "ok");
 * } catch (err) {
 *   tracer.endSpan(span.span_id, "error", undefined, {
 *     message: (err as Error).message,
 *   });
 * }
 */
export class TuttiTracer {
  private readonly maxSpans: number;
  private readonly spans: TuttiSpan[] = [];
  private readonly spansById = new Map<string, TuttiSpan>();
  private readonly subscribers = new Set<SpanSubscriber>();

  constructor(options: TuttiTracerOptions = {}) {
    const requested = options.max_spans ?? DEFAULT_MAX_SPANS;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(
        `TuttiTracer: max_spans must be a positive integer, got ${String(requested)}`,
      );
    }
    this.maxSpans = requested;
  }

  /**
   * Open a new span. The trace id is inherited from `parent_span_id` when
   * the parent is known to this tracer; otherwise a fresh trace id is
   * generated and the parent id is recorded as-is (useful for spans that
   * cross a process boundary).
   *
   * Subscribers fire synchronously with the newly created span.
   *
   * @param name - Short dotted name (e.g. `"tool.call"`).
   * @param kind - One of {@link SpanKind}.
   * @param attributes - Initial attributes for the span. Copied into the
   *   span — later mutation of the caller's object will not affect it.
   * @param parent_span_id - Parent span this work nests under.
   * @returns The newly created (still running) span.
   */
  startSpan(
    name: string,
    kind: SpanKind,
    attributes: TuttiSpanAttributes = {},
    parent_span_id?: string,
  ): TuttiSpan {
    const parent =
      parent_span_id !== undefined ? this.spansById.get(parent_span_id) : undefined;
    const trace_id = parent?.trace_id ?? randomUUID();

    const span: TuttiSpan = {
      span_id: randomUUID(),
      trace_id,
      ...(parent_span_id !== undefined ? { parent_span_id } : {}),
      name,
      kind,
      started_at: new Date(),
      status: "running",
      attributes: { ...attributes },
    };

    this.record(span);
    this.notify(span);
    return span;
  }

  /**
   * Close a previously opened span. Computes `duration_ms`, sets `status`,
   * merges any `extra_attributes`, and attaches an `error` when provided.
   *
   * Subscribers fire synchronously with the now-closed span.
   *
   * @param span_id - Id returned from {@link startSpan}.
   * @param status - Final status — `'ok'` or `'error'`.
   * @param extra_attributes - Attributes to merge over the span's existing
   *   attributes (typically the LLM token counts known only at completion).
   * @param error - Error payload to attach when `status === 'error'`.
   * @throws {Error} When the span id is unknown to this tracer.
   */
  endSpan(
    span_id: string,
    status: Exclude<SpanStatus, "running">,
    extra_attributes?: Partial<TuttiSpanAttributes>,
    error?: TuttiSpanError,
  ): void {
    const span = this.spansById.get(span_id);
    if (!span) {
      throw new Error(`TuttiTracer: unknown span_id ${span_id}`);
    }

    const ended_at = new Date();
    span.ended_at = ended_at;
    span.duration_ms = ended_at.getTime() - span.started_at.getTime();
    span.status = status;
    if (extra_attributes) {
      span.attributes = { ...span.attributes, ...extra_attributes };
    }
    if (error) {
      span.error = error;
    }

    this.notify(span);
  }

  /**
   * Return every span (open or closed) belonging to a trace, in insertion
   * order. Spans evicted by the ring buffer are not included.
   */
  getTrace(trace_id: string): TuttiSpan[] {
    return this.spans.filter((s) => s.trace_id === trace_id);
  }

  /**
   * Return every span currently held in the ring buffer, in insertion
   * order. The returned array is a defensive copy — the caller is free to
   * sort or filter it without affecting the tracer's internal state.
   *
   * Useful for exporters and UIs that want to render a list of recent
   * traces grouped by `trace_id`.
   */
  getAllSpans(): TuttiSpan[] {
    return [...this.spans];
  }

  /**
   * Subscribe to span lifecycle events for live tailing (Studio, log
   * exporter, OTel bridge). The callback fires once on `startSpan` and
   * once on `endSpan` for every span produced after subscription.
   *
   * Subscriber exceptions are caught and ignored so a single bad listener
   * cannot break the agent loop.
   *
   * @returns An unsubscribe function. Idempotent.
   */
  subscribe(cb: SpanSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Append a span to the ring buffer, evicting the oldest entry when the
   * buffer is full.
   */
  private record(span: TuttiSpan): void {
    this.spans.push(span);
    this.spansById.set(span.span_id, span);
    if (this.spans.length > this.maxSpans) {
      const evicted = this.spans.shift();
      if (evicted) {
        this.spansById.delete(evicted.span_id);
      }
    }
  }

  private notify(span: TuttiSpan): void {
    for (const cb of this.subscribers) {
      try {
        cb(span);
      } catch {
        // Subscriber exceptions must never break the agent loop. The
        // tracer has no logger of its own — drop and continue.
      }
    }
  }
}

let _singleton: TuttiTracer | undefined;

/**
 * Return the process-wide {@link TuttiTracer} singleton. Same instance is
 * shared across every caller in the process, so external observers
 * (Studio, exporters, log sinks) and helpers like
 * {@link getRunCost} that look up trace history all see the same spans.
 *
 * The singleton is created lazily on first access.
 */
export function getTuttiTracer(): TuttiTracer {
  if (!_singleton) {
    _singleton = new TuttiTracer();
  }
  return _singleton;
}
