/**
 * Zod schemas for the JSON bodies the Tutti server returns from its
 * `/cost/*` routes. Consumers such as `@tuttiai/cli` validate every
 * response with these before rendering it, so a malformed or hostile
 * body fails with a clear error instead of crashing deep in the
 * renderers.
 *
 * Objects strip unknown keys (Zod's default) so a newer server that adds
 * a field never breaks an older client. Lists and strings are bounded to
 * keep rendering cheap; the bounds protect the renderers, not memory,
 * because the whole body has already been read and parsed by then.
 *
 * @module
 */

import { z } from "zod";

/** Most items accepted in any list; the CLI itself asks for at most 10 000 runs. */
const MAX_ITEMS = 10_000;
/** Longest identifier or name accepted. */
const MAX_NAME = 512;

const name = z.string().max(MAX_NAME);
const isoDate = z.string().datetime();
const amount = z.number().finite();
const count = z.number().finite().int().nonnegative();

/** One row of `GET /cost/runs`: the cost of a single run. */
export const CostRunSchema = z.object({
  run_id: name,
  agent_name: name,
  /** ISO-8601 timestamp, as produced by `Date.prototype.toISOString()`. */
  started_at: isoDate,
  cost_usd: amount,
  total_tokens: count,
});

/** One row of `GET /cost/runs`, derived from {@link CostRunSchema}. */
export type CostRun = z.infer<typeof CostRunSchema>;

/**
 * Body of `GET /cost/runs`. `store_missing` is `true`, with an empty
 * `runs` list, when the runtime has no `RunCostStore` configured.
 */
export const CostRunsResponseSchema = z.object({
  since: isoDate.nullable(),
  until: isoDate.nullable(),
  agent_id: name.nullable(),
  store_missing: z.boolean(),
  runs: z.array(CostRunSchema).max(MAX_ITEMS),
});

/** Body of `GET /cost/runs`, derived from {@link CostRunsResponseSchema}. */
export type CostRunsResponse = z.infer<typeof CostRunsResponseSchema>;

/** One row of `GET /cost/tools`: live usage of a single tool. */
export const CostToolUsageSchema = z.object({
  tool_name: name,
  call_count: count,
  total_llm_tokens: count,
  /** May be a fraction (`total_llm_tokens / call_count`). */
  avg_llm_tokens_per_call: amount.nonnegative(),
});

/** One row of `GET /cost/tools`, derived from {@link CostToolUsageSchema}. */
export type CostToolUsage = z.infer<typeof CostToolUsageSchema>;

/**
 * Body of `GET /cost/tools`, aggregated from the server's in-memory
 * tracer window.
 */
export const CostToolsResponseSchema = z.object({
  window_started_at: isoDate,
  window_span_count: count,
  tools: z.array(CostToolUsageSchema).max(MAX_ITEMS),
});

/** Body of `GET /cost/tools`, derived from {@link CostToolsResponseSchema}. */
export type CostToolsResponse = z.infer<typeof CostToolsResponseSchema>;

/**
 * One row of `GET /cost/budgets`: an agent's budget configuration and
 * its spend so far. The totals are `null` when no store is configured,
 * and `budget` is absent when the agent has none.
 */
export const CostAgentBudgetSchema = z.object({
  agent_id: name,
  budget: z
    .object({
      max_tokens: amount.optional(),
      max_cost_usd: amount.optional(),
      max_cost_usd_per_day: amount.optional(),
      max_cost_usd_per_month: amount.optional(),
      warn_at_percent: amount.optional(),
    })
    .optional(),
  daily_total_usd: amount.nullable(),
  monthly_total_usd: amount.nullable(),
});

/** One row of `GET /cost/budgets`, derived from {@link CostAgentBudgetSchema}. */
export type CostAgentBudget = z.infer<typeof CostAgentBudgetSchema>;

/** Body of `GET /cost/budgets`. */
export const CostBudgetsResponseSchema = z.object({
  agents: z.array(CostAgentBudgetSchema).max(MAX_ITEMS),
});

/** Body of `GET /cost/budgets`, derived from {@link CostBudgetsResponseSchema}. */
export type CostBudgetsResponse = z.infer<typeof CostBudgetsResponseSchema>;
