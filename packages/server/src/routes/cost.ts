/**
 * `/cost/*` routes — aggregate cost data for the CLI's
 * `analyze costs` / `report costs` / `budgets` commands and any custom
 * dashboards.
 *
 * Backed by the runtime's {@link RunCostStore}: persistent, multi-process
 * safe (with `PostgresRunCostStore`), and the same source the budget
 * enforcement reads from. When no store is configured the routes return
 * empty data rather than 500 — the CLI then renders a friendly "configure
 * a RunCostStore" message.
 */

import type { FastifyInstance } from "fastify";
import type { TuttiRuntime, TuttiSpan } from "@tuttiai/core";
import { getDailyCost, getMonthlyCost, getTuttiTracer } from "@tuttiai/core";

interface RunCostRecordWire {
  run_id: string;
  agent_name: string;
  /** ISO-8601 string so JSON round-trips cleanly. */
  started_at: string;
  cost_usd: number;
  total_tokens: number;
}

interface RunsResponse {
  /** ISO-8601 lower bound applied to the query. */
  since: string | null;
  /** ISO-8601 upper bound applied to the query. */
  until: string | null;
  /** `agent_name` filter applied, if any. */
  agent_id: string | null;
  /** `true` when the runtime has no store configured. */
  store_missing: boolean;
  runs: RunCostRecordWire[];
}

interface ToolUsageRow {
  tool_name: string;
  call_count: number;
  /** Total prompt + completion tokens of the LLM calls in traces that
   *  used this tool. Proxy for "how expensive are runs that use this
   *  tool" — never authoritative per-tool. */
  total_llm_tokens: number;
  /** Average tokens-per-call (`total_llm_tokens / call_count`). */
  avg_llm_tokens_per_call: number;
}

interface ToolsResponse {
  /**
   * Live-window framing — these counts come from the in-memory tracer's
   * ring buffer, which is bounded (default 1000 spans) and lost on
   * server restart. The CLI surfaces `window_started_at` so the
   * caller knows what they're looking at.
   */
  window_started_at: string;
  window_span_count: number;
  tools: ToolUsageRow[];
}

interface BudgetsResponse {
  agent_id: string;
  /** Per-agent budget config from the score. Absent when the agent has
   *  no `budget` field. */
  budget?: {
    max_tokens?: number;
    max_cost_usd?: number;
    max_cost_usd_per_day?: number;
    max_cost_usd_per_month?: number;
    warn_at_percent?: number;
  };
  /** USD totals from the run-cost store, or `null` when no store is configured. */
  daily_total_usd: number | null;
  monthly_total_usd: number | null;
}

function parseDate(input: string | undefined): Date | undefined {
  if (input === undefined) return undefined;
  const t = Date.parse(input);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

function parsePositiveInt(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Register the `/cost` route family on the Fastify app.
 *
 * - `GET /cost/runs?since=&until=&agent_id=&limit=` — list run-cost records.
 * - `GET /cost/budgets?agent_id=` — per-agent budget config + daily/monthly totals.
 */
export function registerCostRoutes(app: FastifyInstance, runtime: TuttiRuntime): void {
  app.get<{ Querystring: { since?: string; until?: string; agent_id?: string; limit?: string } }>(
    "/cost/runs",
    async (request) => {
      const since = parseDate(request.query.since);
      const until = parseDate(request.query.until);
      const agent = request.query.agent_id;
      const limit = parsePositiveInt(request.query.limit) ?? 100;

      const store = runtime.runCostStore;
      if (!store) {
        const empty: RunsResponse = {
          since: since?.toISOString() ?? null,
          until: until?.toISOString() ?? null,
          agent_id: agent ?? null,
          store_missing: true,
          runs: [],
        };
        return empty;
      }

      const records = await store.list({
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(agent !== undefined ? { agent_name: agent } : {}),
        limit,
        order: "desc",
      });
      const body: RunsResponse = {
        since: since?.toISOString() ?? null,
        until: until?.toISOString() ?? null,
        agent_id: agent ?? null,
        store_missing: false,
        runs: records.map((r) => ({
          run_id: r.run_id,
          agent_name: r.agent_name,
          started_at: r.started_at.toISOString(),
          cost_usd: r.cost_usd,
          total_tokens: r.total_tokens,
        })),
      };
      return body;
    },
  );

  app.get("/cost/tools", () => {
    const tracer = getTuttiTracer();
    const allSpans = tracer.getAllSpans();
    return aggregateToolUsage(allSpans);
  });

  app.get<{ Querystring: { agent_id?: string } }>("/cost/budgets", async (request, reply) => {
    const agentId = request.query.agent_id;
    const score = runtime.score;
    const agents = score.agents as Record<string, { budget?: BudgetsResponse["budget"] }>;
    // Without an explicit agent_id, surface every agent that has a
    // budget configured. This matches how the CLI's `budgets` command
    // renders an overview.
    if (agentId === undefined) {
      const out: BudgetsResponse[] = [];
      for (const [name, agent] of Object.entries(agents)) {
        out.push(await buildBudgetsResponse(runtime, name, agent.budget));
      }
      return { agents: out };
    }
    const agent = agents[agentId];
    if (!agent) {
      return reply.code(404).send({
        error: "agent_not_found",
        message: `Agent "${agentId}" is not in this score.`,
      });
    }
    const single = await buildBudgetsResponse(runtime, agentId, agent.budget);
    return { agents: [single] };
  });
}

/**
 * Aggregate `tool.call` spans into per-tool usage rows. Total LLM
 * tokens are summed across `llm.completion` spans in every trace that
 * also contains at least one call of the tool — this is a proxy for
 * "how expensive are runs that use this tool", explicitly framed as
 * such on the CLI side. Never claims authoritative per-tool cost.
 *
 * Exported so the CLI tests can drive the aggregation directly.
 */
export function aggregateToolUsage(spans: readonly TuttiSpan[]): ToolsResponse {
  let earliest: Date | undefined;
  // Index llm.completion tokens by trace_id for the proxy aggregation.
  const tokensByTrace = new Map<string, number>();
  // Group tool.call spans by tool_name, also remembering the trace ids
  // they belong to so we can attribute trace tokens once per (tool, trace).
  const toolTraces = new Map<string, { count: number; traceIds: Set<string> }>();

  for (const s of spans) {
    if (earliest === undefined || s.started_at < earliest) earliest = s.started_at;
    if (s.name === "llm.completion") {
      const total = s.attributes.total_tokens ?? 0;
      tokensByTrace.set(s.trace_id, (tokensByTrace.get(s.trace_id) ?? 0) + total);
      continue;
    }
    if (s.name === "tool.call") {
      const name = s.attributes.tool_name;
      if (typeof name !== "string" || name.length === 0) continue;
      const entry = toolTraces.get(name) ?? { count: 0, traceIds: new Set<string>() };
      entry.count += 1;
      entry.traceIds.add(s.trace_id);
      toolTraces.set(name, entry);
    }
  }

  const tools: ToolUsageRow[] = [];
  for (const [name, entry] of toolTraces) {
    let totalTokens = 0;
    for (const traceId of entry.traceIds) {
      totalTokens += tokensByTrace.get(traceId) ?? 0;
    }
    const avg = entry.count > 0 ? totalTokens / entry.count : 0;
    tools.push({
      tool_name: name,
      call_count: entry.count,
      total_llm_tokens: totalTokens,
      avg_llm_tokens_per_call: avg,
    });
  }
  // Most-used first — the CLI's `analyze costs` table truncates to top 5.
  tools.sort((a, b) => b.call_count - a.call_count);

  return {
    window_started_at: (earliest ?? new Date()).toISOString(),
    window_span_count: spans.length,
    tools,
  };
}

async function buildBudgetsResponse(
  runtime: TuttiRuntime,
  agentId: string,
  budget: BudgetsResponse["budget"] | undefined,
): Promise<BudgetsResponse> {
  const store = runtime.runCostStore;
  let daily_total_usd: number | null = null;
  let monthly_total_usd: number | null = null;
  if (store) {
    daily_total_usd = await getDailyCost(store);
    monthly_total_usd = await getMonthlyCost(store);
  }
  return {
    agent_id: agentId,
    ...(budget !== undefined ? { budget } : {}),
    daily_total_usd,
    monthly_total_usd,
  };
}
