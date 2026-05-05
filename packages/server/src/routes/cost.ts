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
import type { TuttiRuntime } from "@tuttiai/core";
import { getDailyCost, getMonthlyCost } from "@tuttiai/core";

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
