import { getTuttiTracer } from "../tracer.js";
import type { SpanExporter } from "./types.js";

export type { SpanExporter } from "./types.js";
export { OTLPExporter, type OTLPExporterOptions } from "./otlp.js";
export { JsonFileExporter, type JsonFileExporterOptions } from "./json-file.js";

/**
 * State for the currently-installed exporter, if any. Module-scoped so
 * repeated `configureExporter` calls can swap exporters cleanly.
 */
let _active:
  | { exporter: SpanExporter; unsubscribe: () => void }
  | undefined;

/**
 * Hook a {@link SpanExporter} into the {@link getTuttiTracer} singleton so
 * every emitted span is forwarded to it.
 *
 * Calling `configureExporter(undefined)` (or `null`) detaches the current
 * exporter and shuts it down. Calling with a new exporter when one is
 * already attached swaps them — the previous exporter is shut down first.
 *
 * Returns a teardown function that detaches and shuts down the exporter
 * passed in. Useful in tests and for short-lived runs.
 *
 * @example
 * const stop = configureExporter(new JsonFileExporter({ path: "spans.jsonl" }));
 * await runtime.run("agent", "hi");
 * await stop();
 */
export function configureExporter(
  exporter: SpanExporter | undefined | null,
): () => Promise<void> {
  // Tear down whatever was previously installed.
  const prev = _active;
  _active = undefined;
  if (prev) {
    prev.unsubscribe();
    void prev.exporter.shutdown();
  }

  if (!exporter) {
    return () => Promise.resolve();
  }

  const unsubscribe = getTuttiTracer().subscribe((span) => {
    exporter.export(span);
  });
  _active = { exporter, unsubscribe };

  return async () => {
    if (_active?.exporter !== exporter) return; // already replaced
    _active.unsubscribe();
    _active = undefined;
    await exporter.shutdown();
  };
}

/**
 * Return the currently-installed exporter, or `undefined` when none is
 * attached. Mainly for diagnostics — most callers should use the teardown
 * function returned by {@link configureExporter}.
 */
export function getActiveExporter(): SpanExporter | undefined {
  return _active?.exporter;
}
