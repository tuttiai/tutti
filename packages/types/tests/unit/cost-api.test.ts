import { describe, expect, it } from "vitest";

import {
  CostBudgetsResponseSchema,
  CostRunsResponseSchema,
  CostToolsResponseSchema,
} from "../../src/index.js";

const ISO = "2026-11-09T19:30:00.000Z";
const OVER_CAP = 10_001;

/** Built exactly as `packages/server/src/routes/cost.ts` builds a run row. */
function run(i: number): Record<string, unknown> {
  return { run_id: "run-" + i, agent_name: "writer", started_at: ISO, cost_usd: 0.012, total_tokens: 420 };
}

function runsBody(runs: unknown[]): Record<string, unknown> {
  return { since: ISO, until: null, agent_id: null, store_missing: false, runs };
}

function tool(i: number): Record<string, unknown> {
  return { tool_name: "tool-" + i, call_count: 3, total_llm_tokens: 1000, avg_llm_tokens_per_call: 333.33 };
}

function toolsBody(tools: unknown[]): Record<string, unknown> {
  return { window_started_at: ISO, window_span_count: 12, tools };
}

function agent(i: number): Record<string, unknown> {
  return {
    agent_id: "agent-" + i,
    budget: { max_cost_usd: 1, max_cost_usd_per_day: 5, warn_at_percent: 80 },
    daily_total_usd: 0.5,
    monthly_total_usd: null,
  };
}

function paths(result: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((i) => i.path.join("."));
}

describe("CostRunsResponseSchema", () => {
  it("accepts a body built like the server's", () => {
    const r = CostRunsResponseSchema.safeParse(runsBody([run(1), run(2)]));
    expect(r.success).toBe(true);
    expect(r.data?.runs).toHaveLength(2);
  });

  it("accepts store_missing with an empty runs list", () => {
    const body = { since: null, until: null, agent_id: "writer", store_missing: true, runs: [] };
    expect(CostRunsResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects a wrong type and names the path", () => {
    const r = CostRunsResponseSchema.safeParse(runsBody([{ ...run(1), cost_usd: "0.01" }]));
    expect(r.success).toBe(false);
    expect(paths(r)).toEqual(["runs.0.cost_usd"]);
  });

  it("rejects a missing field", () => {
    const { store_missing: _omit, ...rest } = runsBody([]);
    expect(paths(CostRunsResponseSchema.safeParse(rest))).toEqual(["store_missing"]);
  });

  it("rejects a timestamp that is not ISO-8601 and a non-finite or fractional count", () => {
    const bad = runsBody([{ ...run(1), started_at: "yesterday", total_tokens: 1.5 }]);
    expect(paths(CostRunsResponseSchema.safeParse(bad)).sort()).toEqual(["runs.0.started_at", "runs.0.total_tokens"]);
  });

  it("strips extra fields", () => {
    const r = CostRunsResponseSchema.safeParse({ ...runsBody([{ ...run(1), secret: "sk-x" }]), extra: 1 });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("extra");
    expect(r.data?.runs[0]).not.toHaveProperty("secret");
  });

  it("rejects a list over the cap and an over-long name", () => {
    const many = Array.from({ length: OVER_CAP }, (_, i) => run(i));
    expect(paths(CostRunsResponseSchema.safeParse(runsBody(many)))).toEqual(["runs"]);
    const long = runsBody([{ ...run(1), agent_name: "a".repeat(513) }]);
    expect(paths(CostRunsResponseSchema.safeParse(long))).toEqual(["runs.0.agent_name"]);
  });
});

describe("CostToolsResponseSchema", () => {
  it("accepts a body built like the server's, with a fractional average", () => {
    expect(CostToolsResponseSchema.safeParse(toolsBody([tool(1)])).success).toBe(true);
  });

  it("accepts an empty tools list", () => {
    expect(CostToolsResponseSchema.safeParse(toolsBody([])).success).toBe(true);
  });

  it("rejects a wrong type", () => {
    expect(paths(CostToolsResponseSchema.safeParse(toolsBody([{ ...tool(1), call_count: "3" }])))).toEqual([
      "tools.0.call_count",
    ]);
  });

  it("rejects a missing field", () => {
    const { window_started_at: _omit, ...rest } = toolsBody([]);
    expect(paths(CostToolsResponseSchema.safeParse(rest))).toEqual(["window_started_at"]);
  });

  it("strips extra fields", () => {
    const r = CostToolsResponseSchema.safeParse(toolsBody([{ ...tool(1), extra: true }]));
    expect(r.data?.tools[0]).not.toHaveProperty("extra");
  });

  it("rejects a list over the cap", () => {
    const many = Array.from({ length: OVER_CAP }, (_, i) => tool(i));
    expect(paths(CostToolsResponseSchema.safeParse(toolsBody(many)))).toEqual(["tools"]);
  });
});

describe("CostBudgetsResponseSchema", () => {
  it("accepts agents with and without a budget", () => {
    const { budget: _omit, ...noBudget } = agent(2);
    expect(CostBudgetsResponseSchema.safeParse({ agents: [agent(1), noBudget] }).success).toBe(true);
  });

  it("accepts an empty agents list", () => {
    expect(CostBudgetsResponseSchema.safeParse({ agents: [] }).success).toBe(true);
  });

  it("rejects a wrong type inside the budget", () => {
    const bad = { ...agent(1), budget: { max_cost_usd: "1" } };
    expect(paths(CostBudgetsResponseSchema.safeParse({ agents: [bad] }))).toEqual(["agents.0.budget.max_cost_usd"]);
  });

  it("rejects a missing total", () => {
    const { daily_total_usd: _omit, ...rest } = agent(1);
    expect(paths(CostBudgetsResponseSchema.safeParse({ agents: [rest] }))).toEqual(["agents.0.daily_total_usd"]);
  });

  it("strips extra fields", () => {
    const r = CostBudgetsResponseSchema.safeParse({ agents: [{ ...agent(1), extra: 1 }], more: 2 });
    expect(r.data?.agents[0]).not.toHaveProperty("extra");
    expect(r.data).not.toHaveProperty("more");
  });

  it("rejects a list over the cap", () => {
    const many = Array.from({ length: OVER_CAP }, (_, i) => agent(i));
    expect(paths(CostBudgetsResponseSchema.safeParse({ agents: many }))).toEqual(["agents"]);
  });
});
