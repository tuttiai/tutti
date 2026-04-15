import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonFileExporter,
  OTLPExporter,
  configureExporter,
  getActiveExporter,
} from "../src/exporters/index.js";
import { TuttiTracer, getTuttiTracer } from "../src/tracer.js";
import type { TuttiSpan } from "../src/types.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tutti-exporter-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildClosedSpan(tracer: TuttiTracer, name = "tool.call"): TuttiSpan {
  const span = tracer.startSpan(name, "tool", { tool_name: "echo" });
  tracer.endSpan(span.span_id, "ok", { tool_output: "hello" });
  return span;
}

function buildRunningSpan(tracer: TuttiTracer): TuttiSpan {
  return tracer.startSpan("agent.run", "agent");
}

/* ------------------------------------------------------------------ */
/*  JsonFileExporter                                                   */
/* ------------------------------------------------------------------ */

describe("JsonFileExporter", () => {
  it("appends one newline-delimited JSON object per closed span", async () => {
    const path = join(tmpDir, "spans.jsonl");
    const exporter = new JsonFileExporter({ path });
    const tracer = new TuttiTracer();

    const a = buildClosedSpan(tracer, "tool.call");
    exporter.export(a);
    const b = buildClosedSpan(tracer, "llm.completion");
    exporter.export(b);

    await exporter.shutdown();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.name).toBe("tool.call");
    expect(second.name).toBe("llm.completion");
    expect(typeof first.started_at).toBe("string"); // Date → ISO
  });

  it("ignores running spans (only closed spans are persisted)", async () => {
    const path = join(tmpDir, "spans.jsonl");
    const exporter = new JsonFileExporter({ path });
    const tracer = new TuttiTracer();

    const running = buildRunningSpan(tracer);
    exporter.export(running);
    const closed = buildClosedSpan(tracer);
    exporter.export(closed);

    await exporter.shutdown();
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { name: string }).name).toBe("tool.call");
  });

  it("does not open the file when no spans are exported", async () => {
    const path = join(tmpDir, "never-written.jsonl");
    const exporter = new JsonFileExporter({ path });
    await exporter.shutdown();
    expect(() => readFileSync(path, "utf8")).toThrow(/ENOENT/);
  });

  it("refuses writes after shutdown", async () => {
    const path = join(tmpDir, "spans.jsonl");
    const exporter = new JsonFileExporter({ path });
    const tracer = new TuttiTracer();

    exporter.export(buildClosedSpan(tracer));
    await exporter.shutdown();
    exporter.export(buildClosedSpan(tracer));

    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  OTLPExporter                                                       */
/* ------------------------------------------------------------------ */

describe("OTLPExporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("flushes when the buffer hits maxBatchSize", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "http://localhost:4318/v1/traces",
      maxBatchSize: 3,
    });
    const tracer = new TuttiTracer();

    exporter.export(buildClosedSpan(tracer));
    exporter.export(buildClosedSpan(tracer));
    expect(fetchMock).not.toHaveBeenCalled();

    exporter.export(buildClosedSpan(tracer)); // hits batch size
    // flush is async — let microtasks run.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:4318/v1/traces");
    const reqInit = init as { method: string; headers: Record<string, string>; body: string };
    expect(reqInit.method).toBe("POST");
    expect(reqInit.headers["Content-Type"]).toBe("application/json");
    // Payload is OTLP JSON — should mention our spans by trace id (no dashes).
    const body = JSON.parse(reqInit.body) as { resourceSpans: Array<Record<string, unknown>> };
    expect(body.resourceSpans).toBeDefined();
    expect(body.resourceSpans.length).toBeGreaterThan(0);

    await exporter.shutdown();
  });

  it("flushes on the configured interval when the batch never fills", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "http://localhost:4318/v1/traces",
      flushIntervalMs: 5_000,
      maxBatchSize: 100,
    });
    const tracer = new TuttiTracer();

    exporter.export(buildClosedSpan(tracer));
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance the timer past flushIntervalMs.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await exporter.shutdown();
  });

  it("includes custom headers on the POST", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "https://api.honeycomb.io/v1/traces",
      headers: { "x-honeycomb-team": "secret-key" },
      maxBatchSize: 1,
    });
    const tracer = new TuttiTracer();
    exporter.export(buildClosedSpan(tracer));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers["x-honeycomb-team"]).toBe("secret-key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    await exporter.shutdown();
  });

  it("retries with exponential backoff on network failure (max 3)", async () => {
    const onError = vi.fn();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "http://localhost:4318/v1/traces",
      maxBatchSize: 1,
      onError,
    });
    const tracer = new TuttiTracer();
    exporter.export(buildClosedSpan(tracer));

    // Drive the retry backoff: 1s, 2s, 4s — but the third attempt is the
    // last and we don't sleep after it. So we need ~3s of advance.
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(calls).toBe(3));

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0]![1]).toBe(1); // attempt number
    expect(onError.mock.calls[2]![1]).toBe(3);

    await exporter.shutdown();
  });

  it("does not retry 4xx responses (permanent failure)", async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "http://localhost:4318/v1/traces",
      maxBatchSize: 1,
      onError,
    });
    const tracer = new TuttiTracer();
    exporter.export(buildClosedSpan(tracer));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries on 4xx

    await exporter.shutdown();
  });

  it("ignores running spans", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = new OTLPExporter({
      endpoint: "http://localhost:4318/v1/traces",
      maxBatchSize: 1,
    });
    const tracer = new TuttiTracer();
    exporter.export(buildRunningSpan(tracer));

    // Wait one tick — no flush should happen.
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();

    await exporter.shutdown();
  });
});

/* ------------------------------------------------------------------ */
/*  configureExporter                                                  */
/* ------------------------------------------------------------------ */

describe("configureExporter", () => {
  afterEach(async () => {
    // Detach whatever we left behind so other tests don't see leaked spans.
    await configureExporter(undefined)();
  });

  it("forwards every span emitted by the singleton tracer to the exporter", () => {
    const seen: TuttiSpan[] = [];
    const exporter = {
      export: (s: TuttiSpan) => seen.push(s),
      flush: async () => {},
      shutdown: async () => {},
    };

    configureExporter(exporter);

    const tracer = getTuttiTracer();
    const span = tracer.startSpan("tool.call", "tool");
    tracer.endSpan(span.span_id, "ok");

    // Subscriber fires on open AND close → two events.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.span_id).toBe(span.span_id);
    expect(seen[1]!.span_id).toBe(span.span_id);
  });

  it("swaps cleanly when called with a new exporter — old one is shut down", async () => {
    const oldShutdown = vi.fn(async () => {});
    const oldExport = vi.fn();
    const newExport = vi.fn();

    configureExporter({
      export: oldExport,
      flush: async () => {},
      shutdown: oldShutdown,
    });

    configureExporter({
      export: newExport,
      flush: async () => {},
      shutdown: async () => {},
    });

    // Yield so the prior shutdown promise can resolve.
    await new Promise((r) => setImmediate(r));
    expect(oldShutdown).toHaveBeenCalled();

    const tracer = getTuttiTracer();
    const span = tracer.startSpan("tool.call", "tool");
    tracer.endSpan(span.span_id, "ok");

    expect(oldExport).not.toHaveBeenCalled();
    expect(newExport).toHaveBeenCalled();
  });

  it("returns a teardown function that detaches the listener", () => {
    const exp = vi.fn();
    const stop = configureExporter({
      export: exp,
      flush: async () => {},
      shutdown: async () => {},
    });

    void stop();

    const tracer = getTuttiTracer();
    const span = tracer.startSpan("tool.call", "tool");
    tracer.endSpan(span.span_id, "ok");

    expect(exp).not.toHaveBeenCalled();
    expect(getActiveExporter()).toBeUndefined();
  });

  it("configureExporter(undefined) detaches without installing anything", () => {
    const stop = configureExporter(undefined);
    expect(typeof stop).toBe("function");
    expect(getActiveExporter()).toBeUndefined();
  });
});
