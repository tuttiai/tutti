import type { ScoreConfig } from "@tuttiai/types";

/**
 * Typed identity function for defining a Tutti score.
 * Provides autocomplete and type checking — no runtime magic.
 */
export function defineScore(config: ScoreConfig): ScoreConfig {
  return config;
}
