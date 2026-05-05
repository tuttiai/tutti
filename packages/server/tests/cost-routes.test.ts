/**
 * Integration tests for the `/cost/*` routes.
 *
 * Drives a real Fastify instance with `inject` so the handlers, schema
 * coercion, and JSON response shape are all exercised end-to-end.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRunCostStore } from "@tuttiai/core";

import { buildTestServer, AGENT_NAME, API_KEY, textResponse } from "./helpers.js";

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}` };
}

describe("GET /cost/runs", () => {
  it("returns store_missing=true and an empty runs list when no store is configured", async () => {
    const { app } = await buildTestServer([textResponse("ok")]);

    const res = await app.inject({
      method: "GET",
      url: "/cost/runs",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      store_missing: boolean;
      runs: unknown[];
    };
    expect(body.store_missing).toBe(true);
    expect(body.runs).toEqual([]);

    await app.close();
  });

  it("returns recorded runs sorted desc, with store_missing=false when a store is wired", async () => {
    const store = new InMemoryRunCostStore();
    await store.record({
      run_id: "old",
      agent_name: AGENT_NAME,
      started_at: new Date("2026-05-01T10:00:00Z"),
      cost_usd: 0.1,
      total_tokens: 100,
    });
    await store.record({
      run_id: "new",
      agent_name: AGENT_NAME,
      started_at: new Date("2026-05-02T10:00:00Z"),
      cost_usd: 0.2,
      total_tokens: 200,
    });

    const { app } = await buildTestServer([textResponse("ok")], {
      runCostStore: store,
    });

    const res = await app.inject({
      method: "GET",
      url: "/cost/runs",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      store_missing: boolean;
      runs: { run_id: string; cost_usd: number }[];
    };
    expect(body.store_missing).toBe(false);
    expect(body.runs.map((r) => r.run_id)).toEqual(["new", "old"]);

    await app.close();
  });

  it("filters by since, until, and agent_id query strings", async () => {
    const store = new InMemoryRunCostStore();
    await store.record({
      run_id: "before",
      agent_name: AGENT_NAME,
      started_at: new Date("2026-04-30T00:00:00Z"),
      cost_usd: 0.1,
      total_tokens: 100,
    });
    await store.record({
      run_id: "in-window",
      agent_name: AGENT_NAME,
      started_at: new Date("2026-05-02T00:00:00Z"),
      cost_usd: 0.2,
      total_tokens: 200,
    });
    await store.record({
      run_id: "after",
      agent_name: AGENT_NAME,
      started_at: new Date("2026-05-05T00:00:00Z"),
      cost_usd: 0.3,
      total_tokens: 300,
    });
    await store.record({
      run_id: "other-agent",
      agent_name: "different",
      started_at: new Date("2026-05-02T12:00:00Z"),
      cost_usd: 0.4,
      total_tokens: 400,
    });

    const { app } = await buildTestServer([textResponse("ok")], {
      runCostStore: store,
    });

    const res = await app.inject({
      method: "GET",
      url:
        "/cost/runs?since=2026-05-01T00:00:00Z&until=2026-05-04T00:00:00Z&agent_id=" +
        AGENT_NAME,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { runs: { run_id: string }[] };
    expect(body.runs.map((r) => r.run_id)).toEqual(["in-window"]);

    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = await buildTestServer([textResponse("ok")], {
      runCostStore: "memory",
    });
    const res = await app.inject({ method: "GET", url: "/cost/runs" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /cost/budgets", () => {
  const baseBudget = {
    max_cost_usd: 0.5,
    max_cost_usd_per_day: 5,
    max_cost_usd_per_month: 50,
  };

  it("returns one row per agent with totals null when no store is configured", async () => {
    const { app } = await buildTestServer([textResponse("ok")], {
      agent: { budget: baseBudget },
    });
    const res = await app.inject({
      method: "GET",
      url: "/cost/budgets",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      agents: { agent_id: string; daily_total_usd: number | null }[];
    };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.agent_id).toBe(AGENT_NAME);
    expect(body.agents[0]?.daily_total_usd).toBeNull();
    await app.close();
  });

  it("returns daily/monthly totals when a store is configured", async () => {
    const store = new InMemoryRunCostStore();
    // Seed a record dated "now" so it falls inside the daily and monthly buckets.
    await store.record({
      run_id: "today",
      agent_name: AGENT_NAME,
      started_at: new Date(),
      cost_usd: 1.25,
      total_tokens: 1000,
    });
    const { app } = await buildTestServer([textResponse("ok")], {
      agent: { budget: baseBudget },
      runCostStore: store,
    });
    const res = await app.inject({
      method: "GET",
      url: "/cost/budgets",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      agents: {
        agent_id: string;
        daily_total_usd: number;
        monthly_total_usd: number;
      }[];
    };
    expect(body.agents[0]?.daily_total_usd).toBeCloseTo(1.25, 5);
    expect(body.agents[0]?.monthly_total_usd).toBeCloseTo(1.25, 5);
    await app.close();
  });

  it("filters to one agent when agent_id is supplied", async () => {
    const { app } = await buildTestServer([textResponse("ok")], {
      agent: { budget: baseBudget },
    });
    const res = await app.inject({
      method: "GET",
      url: "/cost/budgets?agent_id=" + AGENT_NAME,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
    await app.close();
  });

  it("returns 404 when the requested agent_id is not in the score", async () => {
    const { app } = await buildTestServer([textResponse("ok")]);
    const res = await app.inject({
      method: "GET",
      url: "/cost/budgets?agent_id=does-not-exist",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("does not allow prototype keys via agent_id", async () => {
    const { app } = await buildTestServer([textResponse("ok")]);
    const res = await app.inject({
      method: "GET",
      url: "/cost/budgets?agent_id=__proto__",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /cost/tools", () => {
  // The route reads the global `getTuttiTracer()` singleton. Stash a
  // subscriber so tests can confirm spans flow through, but more
  // importantly re-import the module here so we drive the real tracer.

  it("returns the live tracer window plus aggregated tools list", async () => {
    const { app, runtime } = await buildTestServer([textResponse("ok")]);

    // Drive a single agent run so the tracer collects an `agent.run`
    // root, an `llm.completion` child, and (for variety) zero tool
    // calls. The tools list should be empty but the route should still
    // return 200 with the window metadata.
    await runtime.run(AGENT_NAME, "hi");

    const res = await app.inject({
      method: "GET",
      url: "/cost/tools",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      window_started_at: string;
      window_span_count: number;
      tools: { tool_name: string }[];
    };
    expect(body.window_span_count).toBeGreaterThan(0);
    expect(typeof body.window_started_at).toBe("string");
    expect(Array.isArray(body.tools)).toBe(true);
    await app.close();
  });

  it("requires authentication", async () => {
    const { app } = await buildTestServer([textResponse("ok")]);
    const res = await app.inject({ method: "GET", url: "/cost/tools" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

