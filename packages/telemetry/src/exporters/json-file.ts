import { createWriteStream, type WriteStream } from "node:fs";

import type { TuttiSpan } from "../types.js";
import type { SpanExporter } from "./types.js";

/** Construction options for {@link JsonFileExporter}. */
export interface JsonFileExporterOptions {
  /**
   * Filesystem path the exporter appends to. Created if missing; opened in
   * append mode so concurrent runs don't overwrite each other's history.
   */
  path: string;
  /** Optional sink for write errors. The exporter never throws. */
  onError?: (err: unknown) => void;
}

/** JSON-serialisable view of a {@link TuttiSpan} (Date → ISO string). */
function spanToJson(span: TuttiSpan): Record<string, unknown> {
  return {
    span_id: span.span_id,
    trace_id: span.trace_id,
    ...(span.parent_span_id !== undefined ? { parent_span_id: span.parent_span_id } : {}),
    name: span.name,
    kind: span.kind,
    started_at: span.started_at.toISOString(),
    ...(span.ended_at !== undefined ? { ended_at: span.ended_at.toISOString() } : {}),
    ...(span.duration_ms !== undefined ? { duration_ms: span.duration_ms } : {}),
    status: span.status,
    attributes: span.attributes,
    ...(span.error !== undefined ? { error: span.error } : {}),
  };
}

/**
 * Newline-delimited JSON file exporter — one closed span per line.
 *
 * Suitable for offline analysis (`jq`, DuckDB) and for the CI eval flow
 * where you want a deterministic on-disk artefact instead of a live OTLP
 * pipeline.
 *
 * Uses a single append-mode {@link WriteStream}. Writes are queued by the
 * stream so concurrent `export()` calls don't interleave; the file handle
 * stays open for the exporter's lifetime and is closed by {@link shutdown}.
 *
 * Running spans are skipped — the file should reflect completed work only.
 */
export class JsonFileExporter implements SpanExporter {
  private stream: WriteStream | undefined;
  private shuttingDown = false;

  constructor(private readonly opts: JsonFileExporterOptions) {}

  export(span: TuttiSpan): void {
    if (this.shuttingDown) return;
    if (span.status === "running") return;
    try {
      const stream = this.openStream();
      stream.write(JSON.stringify(spanToJson(span)) + "\n");
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /**
   * Force any buffered bytes through the OS write queue. Resolves when the
   * `'drain'` event fires (or immediately if the stream was already drained).
   */
  async flush(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    if (stream.writableNeedDrain) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }

  /** Flush, close the file handle, and refuse further writes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  /** Lazily open the file on first use so empty runs don't touch disk. */
  private openStream(): WriteStream {
    if (this.stream) return this.stream;
    this.stream = createWriteStream(this.opts.path, { flags: "a" });
    this.stream.on("error", (err) => {
      this.opts.onError?.(err);
    });
    return this.stream;
  }
}
