import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

import type { TuttiSpan } from "../types.js";
import { legacySpanNaming } from "../semconv/naming.js";
import { tuttiSpanToReadableSpan } from "./otlp-adapter.js";
import type { SpanExporter } from "./types.js";

/** Default flush cadence when no spans hit the size threshold. */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** Default batch size threshold that triggers an immediate flush. */
const DEFAULT_BATCH_SIZE = 100;
/** Maximum POST attempts per batch before the batch is dropped. */
const MAX_RETRIES = 3;

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
      batch.map((span) => tuttiSpanToReadableSpan(span, legacySpanNaming)),
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
