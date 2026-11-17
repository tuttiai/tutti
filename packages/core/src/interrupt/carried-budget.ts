/**
 * The budget of a run resumed from a pause checkpoint: it carries on from
 * the cost the run had spent when it paused, so a `max_cost_usd` ceiling
 * holds across an approval pause.
 *
 * @module
 */

import type { BudgetConfig } from "@tuttiai/types";

import { logger } from "../logger.js";
import { TokenBudget } from "../token-budget.js";
import type { PausedTurn } from "./pause.js";

/**
 * A saved cost, when it can be trusted.
 *
 * @param value - A cost read back from a checkpoint, of any type.
 * @returns The cost when it is a finite number of at least zero, else `undefined`.
 */
export function validCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * A {@link TokenBudget} that starts from a cost already spent. Every reading
 * of `estimated_cost_usd` includes it, so `check()`, `canAfford()`,
 * `summary()` and the runner's cost checks all see it.
 */
export class CarriedTokenBudget extends TokenBudget {
  /**
   * @param config - The agent's budget.
   * @param model - The model that prices tokens added without an override.
   * @param carried_cost_usd - Cost in USD spent before the pause.
   */
  constructor(
    config: BudgetConfig,
    model: string,
    private readonly carried_cost_usd: number,
  ) {
    super(config, model);
  }

  override get estimated_cost_usd(): number {
    return super.estimated_cost_usd + this.carried_cost_usd;
  }
}

/**
 * The budget for a run, carrying on from a paused turn's saved cost.
 *
 * A paused turn with no saved cost comes from a checkpoint written before
 * cost was kept, or by a run without a budget: its cost counts from zero,
 * with one debug log.
 *
 * @param config - The agent's budget, if any.
 * @param model - The agent's model.
 * @param paused - The paused turn being replayed, if any.
 * @returns No budget when `config` is unset; otherwise one that includes the saved cost.
 */
export function budgetFor(
  config: BudgetConfig | undefined,
  model: string,
  paused?: PausedTurn,
): TokenBudget | undefined {
  if (!config) return undefined;
  const carried = paused?.usage.cost_usd;
  if (paused && carried === undefined) {
    logger.debug(
      { session: paused.session_id },
      "Resuming a paused run with no saved cost; its cost budget counts from zero",
    );
  }
  return carried === undefined ? new TokenBudget(config, model) : new CarriedTokenBudget(config, model, carried);
}
