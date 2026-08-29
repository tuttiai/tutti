/**
 * Budget preparation and cost-limit evaluation for a run.
 *
 * Token limits are enforced by {@link TokenBudget}. Cost limits are evaluated
 * here, across three scopes — this run, today, and this month — with the
 * daily and monthly figures anchored to a snapshot taken at run start.
 */

import type { AgentConfig, BudgetConfig } from "@tuttiai/types";
import { getDailyCost, getMonthlyCost, type RunCostStore } from "@tuttiai/telemetry";
import { TokenBudget } from "../token-budget.js";
import { logger } from "../logger.js";
import type { BudgetScope } from "../errors.js";

/** Default turn ceiling when an agent does not set `max_turns`. */
export const DEFAULT_MAX_TURNS = 10;
/** Default tool-call ceiling when an agent does not set `max_tool_calls`. */
export const DEFAULT_MAX_TOOL_CALLS = 20;

/** The subset of budget config the cost checks read. */
type CostLimits = {
  max_cost_usd?: number;
  max_cost_usd_per_day?: number;
  max_cost_usd_per_month?: number;
};

/**
 * Build the per-scope cost-check rows the runner uses to emit warnings
 * and detect breaches. Each row is included only when its underlying
 * limit is configured. `daily.current` and `monthly.current` add the
 * caller-provided snapshots to this run's accumulated cost.
 *
 * @param cfg - The agent's cost limits.
 * @param runCostUsd - Cost accumulated by this run so far.
 * @param dailySnapshotUsd - Spend already recorded today, at run start.
 * @param monthlySnapshotUsd - Spend already recorded this month, at run start.
 * @returns One row per configured scope.
 */
export function costBudgetChecks(
  cfg: CostLimits,
  runCostUsd: number,
  dailySnapshotUsd: number,
  monthlySnapshotUsd: number,
): Array<{ scope: BudgetScope; current: number; limit: number }> {
  const checks: Array<{ scope: BudgetScope; current: number; limit: number }> = [];
  if (cfg.max_cost_usd !== undefined && cfg.max_cost_usd > 0) {
    checks.push({ scope: "run", current: runCostUsd, limit: cfg.max_cost_usd });
  }
  if (cfg.max_cost_usd_per_day !== undefined && cfg.max_cost_usd_per_day > 0) {
    checks.push({
      scope: "day",
      current: dailySnapshotUsd + runCostUsd,
      limit: cfg.max_cost_usd_per_day,
    });
  }
  if (cfg.max_cost_usd_per_month !== undefined && cfg.max_cost_usd_per_month > 0) {
    checks.push({
      scope: "month",
      current: monthlySnapshotUsd + runCostUsd,
      limit: cfg.max_cost_usd_per_month,
    });
  }
  return checks;
}

/**
 * Return the first scope already over its limit, or `null` when none.
 *
 * @param cfg - The agent's cost limits.
 * @param runCostUsd - Cost accumulated by this run so far.
 * @param dailySnapshotUsd - Spend already recorded today, at run start.
 * @param monthlySnapshotUsd - Spend already recorded this month, at run start.
 * @returns The breaching row, or `null`.
 */
export function checkCostBudgetBreach(
  cfg: CostLimits,
  runCostUsd: number,
  dailySnapshotUsd: number,
  monthlySnapshotUsd: number,
): { scope: BudgetScope; current: number; limit: number } | null {
  for (const c of costBudgetChecks(cfg, runCostUsd, dailySnapshotUsd, monthlySnapshotUsd)) {
    if (c.current >= c.limit) return c;
  }
  return null;
}

/** Everything a run needs to enforce its limits, resolved once at run start. */
export interface PreparedRunBudget {
  /** Turn ceiling for this run. */
  maxTurns: number;
  /** Tool-call ceiling for this run. */
  maxToolCalls: number;
  /** Token budget tracker, when the agent configures one. */
  budget: TokenBudget | undefined;
  /** Cost limits the loop should enforce, with unusable scopes stripped. */
  cfg: BudgetConfig | undefined;
  /** When the run began — also the anchor for the cost snapshots. */
  runStartedAt: Date;
  /** Spend already recorded today at run start. */
  dailySnapshotUsd: number;
  /** Spend already recorded this month at run start. */
  monthlySnapshotUsd: number;
}

/**
 * Resolve a run's limits and take the daily/monthly cost snapshot.
 *
 * The snapshot is taken once and this run's accumulating cost is added to it
 * for every subsequent check. Concurrent runs in other processes can therefore
 * over-spend by at most one run's worth — accepted deliberately, to avoid
 * hitting the cost store on every turn.
 *
 * Daily and monthly enforcement activate only when a {@link RunCostStore} is
 * attached. Without persistence the figures are incoherent — a "daily total"
 * consisting of just this run is meaningless — so those limits are stripped
 * from the returned `cfg` rather than silently mis-enforced.
 *
 * A failing cost store never blocks a run: the failure is logged and the run
 * proceeds as though no spend had been recorded, with the per-run cap intact.
 *
 * @param agent - The agent about to run.
 * @param runCostStore - The cost store, when the runtime has one.
 * @returns The prepared limits and snapshots.
 */
export async function prepareRunBudget(
  agent: AgentConfig,
  runCostStore: RunCostStore | undefined,
): Promise<PreparedRunBudget> {
  const maxTurns = agent.max_turns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = agent.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
  const budget = agent.budget
    ? new TokenBudget(agent.budget, agent.model ?? "")
    : undefined;

  const rawCfg = agent.budget;
  const wantsDaily =
    rawCfg?.max_cost_usd_per_day !== undefined && rawCfg.max_cost_usd_per_day > 0;
  const wantsMonthly =
    rawCfg?.max_cost_usd_per_month !== undefined && rawCfg.max_cost_usd_per_month > 0;
  const runStartedAt = new Date();
  let dailySnapshotUsd = 0;
  let monthlySnapshotUsd = 0;

  if (!runCostStore && (wantsDaily || wantsMonthly)) {
    logger.warn(
      { agent: agent.name },
      "Agent has max_cost_usd_per_day/_per_month set but the runtime has no RunCostStore — skipping daily/monthly enforcement",
    );
  }

  if (runCostStore && (wantsDaily || wantsMonthly)) {
    try {
      if (wantsDaily) {
        dailySnapshotUsd = await getDailyCost(runCostStore, runStartedAt);
      }
      if (wantsMonthly) {
        monthlySnapshotUsd = await getMonthlyCost(runCostStore, runStartedAt);
      }
    } catch (err) {
      // A flaky cost store should not block runs. Log and assume
      // zero spend so far — the per-run cap still applies.
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), agent: agent.name },
        "RunCostStore snapshot failed — proceeding with zero daily/monthly history",
      );
    }
  }

  // Strip daily/monthly limits from the cfg the loop sees when no
  // store is configured, so post-call checks ignore them too.
  const cfg = rawCfg
    ? runCostStore
      ? rawCfg
      : {
          ...(rawCfg.max_tokens !== undefined ? { max_tokens: rawCfg.max_tokens } : {}),
          ...(rawCfg.max_cost_usd !== undefined ? { max_cost_usd: rawCfg.max_cost_usd } : {}),
          ...(rawCfg.warn_at_percent !== undefined ? { warn_at_percent: rawCfg.warn_at_percent } : {}),
        }
    : undefined;

  return {
    maxTurns,
    maxToolCalls,
    budget,
    cfg,
    runStartedAt,
    dailySnapshotUsd,
    monthlySnapshotUsd,
  };
}
