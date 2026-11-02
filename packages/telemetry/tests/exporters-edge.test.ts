import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileExporter, OTLPExporter } from "../src/exporters/index.js";
import { TuttiTracer } from "../src/tracer.js";
import type { TuttiSpan } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tutti-exporter-edge-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function closedSpan(tracer: TuttiTracer, toolInput: unknown): TuttiSpan {
  const span = tracer.startSpan("tool.call", "tool", { tool_name: "echo", tool_input: toolInput });
  tracer.endSpan(span.span_id, "ok");
  return span;
}

describe("JsonFileExporter edge cases", () => {
  it("reports a synchronous open failure through onError instead of throwing", () => {
    const onError = vi.fn();
    const exporter = new JsonFileExporter({ path: join(tmpDir, "bad\0name.jsonl"), onError });

    expect(() => exporter.export(closedSpan(new TuttiTracer(), "x"))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports an asynchronous stream error through onError", async () => {
    const onError = vi.fn();
    const exporter = new JsonFileExporter({ path: join(tmpDir, "missing", "spans.jsonl"), onError });

    exporter.export(closedSpan(new TuttiTracer(), "x"));

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await exporter.shutdown();
  });

  it("flush resolves immediately when nothing has been written", async () => {
    const exporter = new JsonFileExporter({ path: join(tmpDir, "never.jsonl") });
    await expect(exporter.flush()).resolves.toBeUndefined();
  });

  it("flush waits for drain after a write larger than the stream buffer", async () => {
    const path = join(tmpDir, "big.jsonl");
    const exporter = new JsonFileExporter({ path });

    exporter.export(closedSpan(new TuttiTracer(), "y".repeat(64 * 1024)));
    await exporter.flush();
    await exporter.flush();
    await exporter.shutdown();

    expect(readFileSync(path, "utf8").length).toBeGreaterThan(64 * 1024);
  });
});

describe("OTLPExporter edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function exportedBody(toolInput: unknown): Promise<string> {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const exporter = new OTLPExporter({ endpoint: "http://localhost:4318/v1/traces", maxBatchSize: 1 });

    exporter.export(closedSpan(new TuttiTracer(), toolInput));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await exporter.shutdown();
    return fetchMock.mock.calls[0]?.[1].body ?? "";
  }

  it("keeps arrays of strings, numbers and booleans as array attributes", async () => {
    expect(await exportedBody(["a", "b"])).toContain("arrayValue");
    expect(await exportedBody([1, 2])).toContain("arrayValue");
    expect(await exportedBody([true, false])).toContain("arrayValue");
  });

  it("stringifies mixed arrays and objects", async () => {
    expect(await exportedBody([1, "a"])).toContain(String.raw`[1,\"a\"]`);
    expect(await exportedBody({ k: "v" })).toContain(String.raw`{\"k\":\"v\"}`);
  });

  it("falls back to the object tag for values JSON cannot serialise", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(await exportedBody(circular)).toContain("[object Object]");
    expect(await exportedBody(10n)).toContain("[object BigInt]");
  });

  it("drops null attribute values", async () => {
    expect(await exportedBody(null)).not.toContain("tool_input");
  });

  it("retries 5xx responses and reports each attempt", async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn(async () => new Response("", { status: 503, statusText: "Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const exporter = new OTLPExporter({ endpoint: "http://localhost:4318/v1/traces", maxBatchSize: 1, onError });

    exporter.export(closedSpan(new TuttiTracer(), "x"));
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(onError).toHaveBeenCalledTimes(3);
    expect(String(onError.mock.calls[0]?.[0])).toContain("OTLP export failed: 503");
    await exporter.shutdown();
  });
});
