import { vi } from "vitest";

import { OTLPExporter, type OTLPExporterOptions } from "../../src/exporters/otlp.js";
import type { TuttiSpan } from "../../src/types.js";

/**
 * Push spans through the real OTLPExporter with `fetch` stubbed, and
 * return the JSON body it POSTed. No network. Call with fake timers on.
 */
export async function exportAndCapture(
  spans: readonly TuttiSpan[],
  extra: Partial<OTLPExporterOptions> = {},
): Promise<string> {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response("", { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const exporter = new OTLPExporter({
    endpoint: "http://collector.test/v1/traces",
    maxBatchSize: 1000,
    ...extra,
  });
  for (const span of spans) exporter.export(span);
  await exporter.shutdown();
  const body = fetchMock.mock.calls[0]?.[1].body;
  if (typeof body !== "string") throw new Error("OTLPExporter did not POST a string body");
  return body;
}

/** Stable, diff-friendly form of an OTLP JSON body for file snapshots. */
export function prettyJson(body: string): string {
  // JSON.parse returns any; widening to unknown is always safe.
  return `${JSON.stringify(JSON.parse(body) as unknown, null, 2)}\n`;
}
