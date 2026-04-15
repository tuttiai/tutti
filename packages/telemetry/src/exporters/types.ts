import type { TuttiSpan } from "../types.js";

/**
 * Pluggable span sink. Implementations may batch, transform, or forward
 * spans anywhere — files, OTLP collectors, log services, etc.
 *
 * Contract:
 * - `export()` is fire-and-forget. It must never throw — exporter errors
 *   should be swallowed or logged internally; they must not propagate
 *   into the agent loop. Implementations typically buffer + flush async.
 * - `export()` is called for every span event the tracer fires (open AND
 *   close). Most implementations will ignore the open event and only
 *   forward closed spans (`status !== "running"`).
 * - `flush()` drains any pending in-memory state to the wire.
 * - `shutdown()` flushes then releases resources (timers, file handles,
 *   sockets). After shutdown the exporter must accept no more spans.
 */
export interface SpanExporter {
  /** Synchronously enqueue a span for export. Must never throw. */
  export(span: TuttiSpan): void;
  /** Drain any buffered spans to the underlying sink. */
  flush(): Promise<void>;
  /** Flush + release resources. The exporter is unusable after this resolves. */
  shutdown(): Promise<void>;
}
