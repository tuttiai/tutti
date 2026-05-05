/**
 * Tests for `tutti-ai analyze costs`, `report costs`, and `budgets`
 * rendering. Pure render functions only — no HTTP fetching.
 */

import { describe, expect, it } from "vitest";
import chalk from "chalk";

import {
  bucketByDay,
  buildHints,
  parseLastWindow,
  renderAnalyze,
  renderBudgets,
  renderHints,
  renderReportCsv,
  renderReportJson,
  renderReportText,
  renderTopRuns,
  renderTopTools,
  sparkline,
  type AgentBudget,
  type CostRun,
  type ToolsResponse,
} from "../../src/commands/cost-render.js";

chalk.level = 1;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

function makeRun(partial: Partial<CostRun> & { cost_usd: number }): CostRun {
  return {
    run_id: partial.run_id ?? "00000000-0000-0000-0000-000000000000",
    agent_name: partial.agent_name ?? "assistant",
    started_at: partial.started_at ?? "2026-05-01T12:00:00.000Z",
    cost_usd: partial.cost_usd,
    total_tokens: partial.total_tokens ?? 1000,
  };
}

describe("sparkline", () => {
  it("returns an empty string for an empty input", () => {
    expect(sparkline([])).toBe("");
  });

  it("emits one glyph per input value, mapping to the right bucket", () => {
    const out = sparkline([0, 1, 2, 4, 8]);
    expect(out).toHaveLength(5);
    // Lowest value picks the lowest glyph; highest picks the highest.
    expect(out.startsWith("▁")).toBe(true);
    expect(out.endsWith("█")).toBe(true);
  });

  it("renders all-zero series with the lowest glyph repeated", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });
});

describe("parseLastWindow", () => {
  const now = new Date("2026-05-05T12:00:00Z");

  it("parses days", () => {
    const r = parseLastWindow("7d", now);
    expect(r?.toISOString()).toBe("2026-04-28T12:00:00.000Z");
  });

  it("parses hours", () => {
    const r = parseLastWindow("12h", now);
    expect(r?.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });

  it("rejects nonsense", () => {
    expect(parseLastWindow("garbage", now)).toBeNull();
    expect(parseLastWindow("0d", now)).toBeNull();
    expect(parseLastWindow("1m", now)).toBeNull();
  });
});

describe("bucketByDay", () => {
  it("buckets runs into UTC days, dense across the window", () => {
    const since = new Date("2026-05-01T00:00:00Z");
    const until = new Date("2026-05-03T23:00:00Z");
    const runs = [
      makeRun({ started_at: "2026-05-01T05:00:00Z", cost_usd: 1 }),
      makeRun({ started_at: "2026-05-01T10:00:00Z", cost_usd: 2 }),
      makeRun({ started_at: "2026-05-03T15:00:00Z", cost_usd: 0.5 }),
    ];
    const buckets = bucketByDay(runs, since, until);
    expect(buckets).toEqual([3, 0, 0.5]);
  });

  it("ignores out-of-range timestamps", () => {
    const since = new Date("2026-05-02T00:00:00Z");
    const until = new Date("2026-05-02T23:59:59Z");
    const runs = [
      makeRun({ started_at: "2026-05-01T12:00:00Z", cost_usd: 1 }), // before
      makeRun({ started_at: "2026-05-02T12:00:00Z", cost_usd: 2 }), // in
      makeRun({ started_at: "2026-05-03T12:00:00Z", cost_usd: 4 }), // after
    ];
    const buckets = bucketByDay(runs, since, until);
    const total = buckets.reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
  });
});

describe("renderTopRuns", () => {
  it("renders a friendly empty state", () => {
    expect(stripAnsi(renderTopRuns([]))).toContain("No runs in this window");
  });

  it("includes the run id, agent, and cost for each row", () => {
    const out = stripAnsi(
      renderTopRuns([
        makeRun({ run_id: "abc12345", agent_name: "triage", cost_usd: 0.1234 }),
      ]),
    );
    expect(out).toContain("abc12345"); // shown via slice(0,8) — full id starts with abc12345
    expect(out).toContain("triage");
    expect(out).toContain("$0.1234");
  });

  it("respects the row limit", () => {
    const runs = Array.from({ length: 15 }, (_, i) =>
      makeRun({
        run_id: String(i).padStart(8, "0"),
        cost_usd: 1 - i * 0.05,
      }),
    );
    const out = stripAnsi(renderTopRuns(runs, 5));
    // Header + separator + 5 rows = 7 lines.
    expect(out.split("\n")).toHaveLength(7);
  });
});

describe("buildHints — burn rate", () => {
  const since = new Date("2026-04-29T00:00:00Z");
  const until = new Date("2026-05-05T00:00:00Z"); // 6 days

  function budget(monthly: number, monthlyTotal = 0): AgentBudget {
    return {
      agent_id: "assistant",
      budget: { max_cost_usd_per_month: monthly },
      daily_total_usd: 0,
      monthly_total_usd: monthlyTotal,
    };
  }

  it("emits a burn-rate hint when daily spend would breach the monthly cap", () => {
    // 6 runs × $0.50 = $3 over 6 days → $0.50/day average.
    // Monthly budget $10, monthly so far $0 → 20 days remaining at this rate.
    const runs = Array.from({ length: 6 }, () => makeRun({ cost_usd: 0.5 }));
    const hints = buildHints({ runs, since, until, budgets: [budget(10)] });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.id).toBe("budget.burn-rate.assistant");
    expect(hints[0]?.message).toMatch(/0\.50/); // daily rate
    expect(hints[0]?.message).toMatch(/10\.00/); // monthly cap
    expect(hints[0]?.message).toMatch(/20\.0 days/);
  });

  it("emits a different hint when the monthly budget is already exhausted", () => {
    const runs = [makeRun({ cost_usd: 0.1 })];
    const hints = buildHints({
      runs,
      since,
      until,
      budgets: [budget(5, 6)], // already $6 of $5 used
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.id).toBe("budget.month-exhausted.assistant");
    expect(hints[0]?.message).toMatch(/already used/);
  });

  it("emits no hint when the agent has no monthly budget configured", () => {
    const runs = [makeRun({ cost_usd: 0.5 })];
    const hints = buildHints({
      runs,
      since,
      until,
      budgets: [
        {
          agent_id: "assistant",
          budget: { max_cost_usd: 1.0 },
          daily_total_usd: 0,
          monthly_total_usd: 0,
        },
      ],
    });
    expect(hints).toHaveLength(0);
  });

  it("emits no hint when the daily average is zero", () => {
    const hints = buildHints({ runs: [], since, until, budgets: [budget(10)] });
    expect(hints).toHaveLength(0);
  });
});

describe("renderHints", () => {
  it("renders a friendly empty state when no hints fire", () => {
    expect(stripAnsi(renderHints([]))).toContain("No optimisation hints");
  });

  it("renders each hint as a bullet line", () => {
    const out = stripAnsi(
      renderHints([
        { id: "x", message: "first" },
        { id: "y", message: "second" },
      ]),
    );
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("first");
    expect(out).toContain("second");
  });
});

describe("renderTopTools", () => {
  it("always shows the live-window caveat at the top, even when empty", () => {
    const out = stripAnsi(
      renderTopTools({
        window_started_at: "2026-05-05T12:00:00.000Z",
        window_span_count: 0,
        tools: [],
      }),
    );
    expect(out).toContain("Live window: 0 spans collected since 2026-05-05T12:00");
    expect(out).toContain("No tool calls in this window");
  });

  it("renders rows sorted by call count, truncated to limit", () => {
    const out = stripAnsi(
      renderTopTools(
        {
          window_started_at: "2026-05-05T00:00:00.000Z",
          window_span_count: 100,
          tools: [
            { tool_name: "read_file", call_count: 30, total_llm_tokens: 30000, avg_llm_tokens_per_call: 1000 },
            { tool_name: "write_file", call_count: 10, total_llm_tokens: 5000, avg_llm_tokens_per_call: 500 },
            { tool_name: "search", call_count: 5, total_llm_tokens: 2500, avg_llm_tokens_per_call: 500 },
          ],
        },
        2,
      ),
    );
    expect(out).toContain("Live window:");
    expect(out).toContain("read_file");
    expect(out).toContain("write_file");
    expect(out).not.toContain("search");
  });
});

describe("buildHints — caching (live window)", () => {
  const since = new Date("2026-04-29T00:00:00Z");
  const tools: ToolsResponse = {
    window_started_at: "2026-05-05T00:00:00.000Z",
    window_span_count: 50,
    tools: [
      { tool_name: "read_file", call_count: 47, total_llm_tokens: 90000, avg_llm_tokens_per_call: 1900 },
      { tool_name: "search", call_count: 3, total_llm_tokens: 9000, avg_llm_tokens_per_call: 3000 },
    ],
  };

  it("fires when the most-used tool clears the threshold", () => {
    const hints = buildHints({ runs: [], since, tools });
    const cacheHint = hints.find((h) => h.id.startsWith("tool.frequent-calls."));
    expect(cacheHint).toBeDefined();
    expect(cacheHint?.id).toBe("tool.frequent-calls.read_file");
    expect(cacheHint?.message).toContain("47 times");
    expect(cacheHint?.message).toContain("cache");
  });

  it("does not fire when the top tool is below threshold", () => {
    const sparseTools: ToolsResponse = {
      ...tools,
      tools: [{ tool_name: "x", call_count: 3, total_llm_tokens: 0, avg_llm_tokens_per_call: 0 }],
    };
    const hints = buildHints({ runs: [], since, tools: sparseTools });
    expect(hints.filter((h) => h.id.startsWith("tool.frequent-calls."))).toHaveLength(0);
  });
});

describe("buildHints — model: auto suggestion", () => {
  const since = new Date("2026-04-29T00:00:00Z");
  const cheapTools: ToolsResponse = {
    window_started_at: "2026-05-05T00:00:00.000Z",
    window_span_count: 50,
    tools: [
      { tool_name: "lookup", call_count: 30, total_llm_tokens: 6000, avg_llm_tokens_per_call: 200 },
      { tool_name: "format", call_count: 20, total_llm_tokens: 4000, avg_llm_tokens_per_call: 200 },
    ],
  };
  const expensiveTools: ToolsResponse = {
    ...cheapTools,
    tools: [
      { tool_name: "summarise", call_count: 40, total_llm_tokens: 80000, avg_llm_tokens_per_call: 2000 },
    ],
  };

  it("fires when most live tool calls are short and there is real cost", () => {
    const hints = buildHints({
      runs: [
        {
          run_id: "r1",
          agent_name: "a",
          started_at: "2026-05-01T00:00:00Z",
          cost_usd: 0.5,
          total_tokens: 1000,
        },
      ],
      since,
      tools: cheapTools,
    });
    const autoHint = hints.find((h) => h.id === "model.auto-suggestion");
    expect(autoHint).toBeDefined();
    expect(autoHint?.message).toContain("model: 'auto'");
  });

  it("does not fire when calls are heavy", () => {
    const hints = buildHints({
      runs: [
        {
          run_id: "r1",
          agent_name: "a",
          started_at: "2026-05-01T00:00:00Z",
          cost_usd: 0.5,
          total_tokens: 1000,
        },
      ],
      since,
      tools: expensiveTools,
    });
    expect(hints.filter((h) => h.id === "model.auto-suggestion")).toHaveLength(0);
  });

  it("does not fire when there is no cost data", () => {
    const hints = buildHints({ runs: [], since, tools: cheapTools });
    expect(hints.filter((h) => h.id === "model.auto-suggestion")).toHaveLength(0);
  });
});

describe("renderAnalyze", () => {
  const since = new Date("2026-04-29T00:00:00Z");

  it("renders a friendly message when the store is missing", () => {
    const out = renderAnalyze({ runs: [], since, store_missing: true });
    expect(stripAnsi(out)).toContain("No RunCostStore configured");
  });

  it("renders an empty-window state when no runs match", () => {
    const out = stripAnsi(renderAnalyze({ runs: [], since }));
    expect(out).toContain("No runs in this window");
  });

  it("includes total, sparkline, top runs, and hints sections", () => {
    const runs = [
      makeRun({ cost_usd: 0.05, started_at: "2026-05-01T12:00:00Z" }),
      makeRun({ cost_usd: 0.02, started_at: "2026-05-02T12:00:00Z" }),
    ];
    const out = stripAnsi(
      renderAnalyze({
        runs,
        since,
        budgets: [
          {
            agent_id: "assistant",
            budget: { max_cost_usd_per_month: 1 },
            daily_total_usd: 0,
            monthly_total_usd: 0,
          },
        ],
      }),
    );
    expect(out).toContain("Cost analysis");
    expect(out).toContain("Daily spend:");
    expect(out).toContain("Total:");
    expect(out).toContain("Top runs by cost");
    expect(out).toContain("Hints");
  });
});

describe("renderBudgets", () => {
  it("notes when nothing is configured", () => {
    expect(stripAnsi(renderBudgets([]))).toContain("No agents have a budget");
  });

  it("renders per-agent budget vs current spend", () => {
    const out = stripAnsi(
      renderBudgets([
        {
          agent_id: "assistant",
          budget: {
            max_cost_usd: 0.02,
            max_cost_usd_per_day: 5,
            max_cost_usd_per_month: 50,
          },
          daily_total_usd: 1.24,
          monthly_total_usd: 18.3,
        },
      ]),
    );
    expect(out).toContain("Agent: assistant");
    expect(out).toContain("Per-run budget");
    expect(out).toContain("Daily budget");
    expect(out).toContain("Monthly budget");
    expect(out).toContain("$1.2400");
    expect(out).toContain("$18.3000");
    // Percentage rendering.
    expect(out).toMatch(/24\.\d%/);
    expect(out).toMatch(/36\.\d%/);
  });

  it("flags agents that have no budget configured", () => {
    const out = stripAnsi(
      renderBudgets([{ agent_id: "no-budget", daily_total_usd: 0, monthly_total_usd: 0 }]),
    );
    expect(out).toContain("(no budget configured)");
  });

  it("hides totals when the store is missing (null totals)", () => {
    const out = stripAnsi(
      renderBudgets([
        {
          agent_id: "assistant",
          budget: { max_cost_usd_per_day: 5 },
          daily_total_usd: null,
          monthly_total_usd: null,
        },
      ]),
    );
    expect(out).toContain("Daily budget");
    expect(out).toContain("—");
  });
});

describe("renderReport — text", () => {
  it("summarises totals and per-agent breakdown", () => {
    const out = renderReportText({
      runs: [
        makeRun({ agent_name: "triage", cost_usd: 0.1, total_tokens: 1000 }),
        makeRun({ agent_name: "triage", cost_usd: 0.2, total_tokens: 2000 }),
        makeRun({ agent_name: "evaluator", cost_usd: 0.5, total_tokens: 5000 }),
      ],
      since: new Date("2026-04-29T00:00:00Z"),
    });
    expect(out).toContain("Cost report");
    expect(out).toContain("Total runs:   3");
    expect(out).toContain("$0.8");
    expect(out).toContain("triage");
    expect(out).toContain("evaluator");
  });

  it("returns an empty-window message when no runs match", () => {
    const out = renderReportText({ runs: [], since: new Date() });
    expect(out).toBe("No runs in this window.");
  });
});

describe("renderReport — json", () => {
  it("returns parseable JSON with runs and totals", () => {
    const json = renderReportJson({
      runs: [makeRun({ cost_usd: 0.1 })],
      since: new Date("2026-04-29T00:00:00Z"),
    });
    const parsed = JSON.parse(json) as {
      since: string;
      until: string;
      totals: { runs: number; cost_usd: number };
      runs: unknown[];
    };
    expect(parsed.totals.runs).toBe(1);
    expect(parsed.totals.cost_usd).toBeCloseTo(0.1, 10);
    expect(parsed.runs).toHaveLength(1);
  });
});

describe("renderReport — csv", () => {
  it("emits a header row plus one row per run", () => {
    const csv = renderReportCsv({
      runs: [
        makeRun({ run_id: "abc", agent_name: "triage", cost_usd: 0.1 }),
        makeRun({ run_id: "def", agent_name: "evaluator", cost_usd: 0.2 }),
      ],
      since: new Date(),
    });
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("run_id,agent_name,started_at,total_tokens,cost_usd");
    expect(lines[1]).toContain("abc,triage,");
    expect(lines[2]).toContain("def,evaluator,");
  });

  it("escapes commas, quotes, and newlines in cell values", () => {
    const csv = renderReportCsv({
      runs: [makeRun({ run_id: 'a"b,c', cost_usd: 0.1 })],
      since: new Date(),
    });
    const dataRow = csv.split("\n")[1] ?? "";
    expect(dataRow.startsWith('"a""b,c"')).toBe(true);
  });
});
