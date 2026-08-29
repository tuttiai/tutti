/**
 * Run cost accounting.
 *
 * Per-call costs are recorded on `llm.completion` spans as the run proceeds.
 * At run end they are aggregated into a single figure, attached to the
 * reported usage, and persisted so later runs can enforce daily and monthly
 * caps.
 */

import type { AgentConfig, TokenUsage } from "@tuttiai/types";
import { getRunCost, type RunCostStore } from "@tuttiai/telemetry";
import { getCurrentTraceId } from "../telemetry.js";
import type { TokenBudget } from "../token-budget.js";
import { logger } from "../logger.js";

/** Inputs to {@link finaliseRunCost}. */
export interface RunCostInputs {
  /** The session this run belongs to — used for the fallback run id. */
  sessionId: string;
  /** Token totals accumulated over the run. */
  totalUsage: TokenUsage;
  /** The run's token budget, used as a cost fallback when no span priced. */
  budget: TokenBudget | undefined;
  /** When the run began. */
  runStartedAt: Date;
  /** The cost store, when the runtime has one. */
  runCostStore: RunCostStore | undefined;
}

/** The cost figures a finished run reports. */
export interface FinalisedRunCost {
  /** The active trace id, when tracing is enabled. */
  trace_id: string | undefined;
  /** Token usage, carrying `cost_usd` when the run could be priced. */
  usage: TokenUsage;
}

/**
 * Aggregate and persist a finished run's cost.
 *
 * The aggregate is `null` when no span carried a known model price — a fully
 * custom model with no `registerModelPrice` call, for instance — in which case
 * `cost_usd` is omitted from the reported usage rather than reported as zero.
 *
 * Persistence is best-effort: a store failure is logged and swallowed, because
 * it must not invalidate a run that has already completed successfully. The
 * consequence is that daily and monthly aggregation may be incomplete.
 *
 * @param agent - The agent that ran.
 * @param inputs - Session, usage, budget, start time and the cost store.
 * @returns The trace id and the usage figures for the result.
 */
export async function finaliseRunCost(
  agent: AgentConfig,
  inputs: RunCostInputs,
): Promise<FinalisedRunCost> {
  const { sessionId, totalUsage, budget, runStartedAt, runCostStore } = inputs;

  const trace_id = getCurrentTraceId();
  // Aggregate per-call cost recorded on llm.completion spans into a
  // single per-run figure. Null when no span had a known model price
  // (e.g. fully custom model with no registerModelPrice call).
  const runCost = trace_id !== undefined ? getRunCost(trace_id).cost_usd : null;
  const usage: TokenUsage = {
    ...totalUsage,
    ...(runCost !== null ? { cost_usd: runCost } : {}),
  };

  if (runCostStore) {
    const storedCost = runCost ?? (budget ? budget.estimated_cost_usd : 0);
    try {
      await runCostStore.record({
        run_id: trace_id ?? `${sessionId}:${runStartedAt.toISOString()}`,
        agent_name: agent.name,
        started_at: runStartedAt,
        cost_usd: storedCost,
        total_tokens: totalUsage.input_tokens + totalUsage.output_tokens,
      });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), agent: agent.name },
        "RunCostStore.record failed — daily/monthly aggregation may be incomplete",
      );
    }
  }

  return { trace_id, usage };
}
