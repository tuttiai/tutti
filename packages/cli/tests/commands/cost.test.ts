/**
 * `tutti-ai analyze costs`, `report costs` and `budgets` against a mocked
 * `fetch`: every response is validated, and a malformed one ends the
 * command with exit code 1 and an error naming the endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeCostsCommand, budgetsCommand, reportCostsCommand } from "../../src/commands/cost.js";
import { renderBudgets, renderReportText } from "../../src/commands/cost-render.js";

const NOW = new Date("2026-11-09T19:30:00.000Z");
const ISO = NOW.toISOString();
const OPTS = { url: "http://example:9999", apiKey: "test-key" };

interface Route {
  status?: number;
  body: unknown;
}

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function stubRoutes(routes: Record<string, Route>): void {
  const table = new Map(Object.entries(routes));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const route = table.get(new URL(url).pathname) ?? { status: 404, body: {} };
      const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
      return Promise.resolve(new Response(text, { status: route.status ?? 200 }));
    }),
  );
}

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

function run(i: number): Record<string, unknown> {
  return { run_id: "run-" + i, agent_name: "writer", started_at: ISO, cost_usd: 0.01, total_tokens: 100 };
}

function runsBody(runs: unknown[]): Record<string, unknown> {
  return { since: ISO, until: null, agent_id: null, store_missing: false, runs };
}

const AGENT = { agent_id: "writer", budget: { max_cost_usd: 1 }, daily_total_usd: 0.2, monthly_total_usd: 3 };
const TOOLS = { window_started_at: ISO, window_span_count: 4, tools: [] };

async function expectExit(promise: Promise<void>, endpoint: string): Promise<string> {
  await expect(promise).rejects.toThrow("process.exit(1)");
  const err = printed(errSpy);
  expect(err).toContain("Error: unexpected response from " + endpoint + " (HTTP 200).");
  expect(err).not.toMatch(/\n\s+at |ZodError/);
  return err;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(
    // Safe: the stub never returns, it throws so the test can see the exit code.
    ((code?: number) => {
      throw new Error("process.exit(" + String(code) + ")");
    }) as typeof process.exit,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("budgets", () => {
  it("renders a valid response", async () => {
    stubRoutes({ "/cost/budgets": { body: { agents: [AGENT] } } });
    await budgetsCommand(OPTS);
    expect(printed(logSpy)).toBe(renderBudgets([AGENT]));
  });

  it("renders an empty list exactly as before", async () => {
    stubRoutes({ "/cost/budgets": { body: { agents: [] } } });
    await budgetsCommand(OPTS);
    expect(printed(logSpy)).toBe(renderBudgets([]));
  });

  it("exits 1 on a missing field", async () => {
    stubRoutes({ "/cost/budgets": { body: {} } });
    const err = await expectExit(budgetsCommand(OPTS), "GET /cost/budgets");
    expect(err).toContain("  - agents: expected array, received undefined");
  });

  it("exits 1 on a list over the cap", async () => {
    stubRoutes({ "/cost/budgets": { body: { agents: Array.from({ length: 10_001 }, () => AGENT) } } });
    const err = await expectExit(budgetsCommand(OPTS), "GET /cost/budgets");
    expect(err).toContain("  - agents: too_big");
  });
});

describe("report costs", () => {
  it("renders an empty list with store_missing exactly as before", async () => {
    stubRoutes({ "/cost/runs": { body: { ...runsBody([]), store_missing: true } } });
    await reportCostsCommand(OPTS);
    const since = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(printed(logSpy)).toBe(renderReportText({ runs: [], since }));
  });

  it("exits 1 on a wrong type", async () => {
    stubRoutes({ "/cost/runs": { body: runsBody([{ ...run(1), cost_usd: "0.01" }]) } });
    const err = await expectExit(reportCostsCommand(OPTS), "GET /cost/runs");
    expect(err).toContain("  - runs.0.cost_usd: expected number, received string");
  });

  it("exits 1 on a body that is not JSON", async () => {
    stubRoutes({ "/cost/runs": { body: "<html>oops</html>" } });
    const err = await expectExit(reportCostsCommand(OPTS), "GET /cost/runs");
    expect(err).toContain("  - response body is not valid JSON");
    expect(err).not.toContain("oops");
  });

  it("exits 1 on a list over the cap, without the host or query in the error", async () => {
    stubRoutes({ "/cost/runs": { body: runsBody(Array.from({ length: 10_001 }, (_, i) => run(i))) } });
    const err = await expectExit(reportCostsCommand(OPTS), "GET /cost/runs");
    expect(err).toContain("  - runs: too_big");
    expect(err).not.toMatch(/example|since=|limit=/);
  });

  it("ignores extra fields and never prints them", async () => {
    stubRoutes({ "/cost/runs": { body: { ...runsBody([{ ...run(1), token: "sk-live-PLANTED" }]), extra: 1 } } });
    await reportCostsCommand({ ...OPTS, format: "json" });
    expect(printed(logSpy)).toContain("run-1");
    expect(printed(logSpy)).not.toContain("PLANTED");
  });
});

describe("analyze costs", () => {
  const valid = {
    "/cost/runs": { body: runsBody([run(1)]) },
    "/cost/budgets": { body: { agents: [AGENT] } },
  };

  it("renders when every response is valid", async () => {
    stubRoutes({ ...valid, "/cost/tools": { body: TOOLS } });
    await analyzeCostsCommand(OPTS);
    expect(printed(logSpy)).toContain("writer");
  });

  it("still renders when the tools endpoint is unavailable", async () => {
    stubRoutes({ ...valid, "/cost/tools": { status: 500, body: "down" } });
    await analyzeCostsCommand(OPTS);
    expect(printed(logSpy)).toContain("writer");
  });

  it("exits 1 when the tools response is malformed", async () => {
    stubRoutes({ ...valid, "/cost/tools": { body: { ...TOOLS, window_span_count: -1 } } });
    const err = await expectExit(analyzeCostsCommand(OPTS), "GET /cost/tools");
    expect(err).toContain("  - window_span_count: too_small");
  });

  it("never prints a planted secret or terminal escape from a hostile body", async () => {
    const hostile = "sk-live-PLANTED\u001b]8;;http://evil.test\u0007click";
    const run1 = { ...run(1), run_id: 42, agent_name: hostile, [hostile]: hostile };
    stubRoutes({ ...valid, "/cost/runs": { body: { ...runsBody([run1]), status: hostile } } });
    const err = await expectExit(analyzeCostsCommand(OPTS), "GET /cost/runs");
    expect(err).toContain("  - runs.0.run_id: expected string, received number");
    expect(err).not.toMatch(/PLANTED|evil|\u001b\]/);
  });
});
