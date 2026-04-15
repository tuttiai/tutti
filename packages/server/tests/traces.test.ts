import { describe, it, expect, afterEach } from "vitest";
import { getTuttiTracer } from "@tuttiai/core";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

/** Helper to build an isolated trace with one llm.completion child. */
function seedTrace(): { traceId: string } {
  const tracer = getTuttiTracer();
  const root = tracer.startSpan("agent.run", "agent", {
    agent_id: "researcher",
    session_id: "sess-test",
    model: "gpt-4o",
  });
  const llm = tracer.startSpan(
    "llm.completion",
    "llm",
    { model: "gpt-4o" },
    root.span_id,
  );
  tracer.endSpan(llm.span_id, "ok", {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost_usd: 0.000125,
  });
  tracer.endSpan(root.span_id, "ok");
  return { traceId: root.trace_id };
}

describe("GET /traces", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 200 with a traces array containing seeded summaries", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));
    const { traceId } = seedTrace();

    const res = await app.inject({
      method: "GET",
      url: "/traces",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { traces: Array<{ trace_id: string; agent_id?: string; total_tokens: number; cost_usd: number | null }> };
    const summary = body.traces.find((t) => t.trace_id === traceId);
    expect(summary).toBeDefined();
    expect(summary!.agent_id).toBe("researcher");
    expect(summary!.total_tokens).toBe(15);
    expect(summary!.cost_usd).toBeCloseTo(0.000125, 10);
  });

  it("requires authentication", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));
    const res = await app.inject({ method: "GET", url: "/traces" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /traces/:id", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 200 with every span belonging to the trace", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));
    const { traceId } = seedTrace();

    const res = await app.inject({
      method: "GET",
      url: `/traces/${traceId}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      trace_id: string;
      spans: Array<{ name: string; kind: string; started_at: string; status: string }>;
    };
    expect(body.trace_id).toBe(traceId);
    expect(body.spans.length).toBe(2);
    expect(body.spans.map((s) => s.name).sort()).toEqual([
      "agent.run",
      "llm.completion",
    ]);
    // started_at should round-trip as a parseable ISO string.
    expect(() => new Date(body.spans[0]!.started_at).toISOString()).not.toThrow();
  });

  it("returns 404 for an unknown trace id", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "GET",
      url: "/traces/no-such-trace-id-exists",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe("trace_not_found");
  });
});

describe("GET /traces/stream (SSE)", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("requires authentication", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "GET",
      url: "/traces/stream",
    });

    expect(res.statusCode).toBe(401);
  });

  it("verifies subscriber wiring at the route level (unit)", () => {
    // The route subscribes via getTuttiTracer().subscribe() and
    // unsubscribes on request close. Confirm those primitives exist
    // and behave — full SSE delivery is covered by the CLI integration.
    const tracer = getTuttiTracer();
    let received = 0;
    const stop = tracer.subscribe(() => {
      received++;
    });

    const span = tracer.startSpan("tool.call", "tool", { tool_name: "echo" });
    tracer.endSpan(span.span_id, "ok");

    stop();
    // One callback on open, one on close.
    expect(received).toBe(2);
  });
});
