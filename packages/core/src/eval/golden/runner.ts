import { createTwoFilesPatch } from "diff";
import type { ScoreConfig } from "@tuttiai/types";

import { TuttiRuntime } from "../../runtime.js";
import { SecretsManager } from "../../secrets.js";
import { logger } from "../../logger.js";
import {
  resolveScorer,
  type EmbeddingsClient,
} from "../scorers/index.js";
import type { Scorer, ScorerInput } from "../scorers/index.js";
import type { GoldenStore } from "./store.js";
import type { GoldenCase, GoldenRun, ScoreResult } from "./types.js";

/** Construction options for {@link GoldenRunner}. */
export interface GoldenRunnerOptions {
  /**
   * Score that carries the provider + agents map. The runner executes
   * `case.agent_id` against the provider configured here. The spec
   * described the parameter as `agentConfig: AgentConfig`; in practice
   * an `AgentConfig` alone has no provider, so we accept a full
   * `ScoreConfig` and look the agent up by `case.agent_id`.
   */
  score: ScoreConfig;
  /**
   * Where to persist the resulting {@link GoldenRun}. When omitted the
   * run is returned but not saved — useful for dry runs.
   */
  store?: GoldenStore;
  /**
   * Override the embeddings client that {@link SimilarityScorer} uses.
   * Primarily for tests that don't want to hit the OpenAI API.
   */
  embeddingsClient?: EmbeddingsClient;
}

/**
 * Runs a {@link GoldenCase} through the agent, invokes every attached
 * scorer, and (optionally) persists the resulting {@link GoldenRun}.
 *
 * Behaviour:
 *  1. Construct a `TuttiRuntime` from the provided score. When
 *     `TUTTI_TEST_MODE` is set, the runner logs that the score's
 *     provider is expected to be a mock — we don't substitute one
 *     silently because downstream tool-using agents depend on
 *     provider responses that match their voice graph.
 *  2. Subscribe to `tool:start` events to record the actual tool
 *     sequence during the run.
 *  3. Run every scorer on the assembled {@link ScorerInput} and
 *     collect the verdicts into `scores`.
 *  4. Compute a unified-format text diff when `expected_output` is
 *     set on the case (uses the `diff` package).
 *  5. Persist the run via the optional store and return it.
 */
export class GoldenRunner {
  private readonly runtime: TuttiRuntime;
  private readonly store: GoldenStore | undefined;
  private readonly embeddingsClient: EmbeddingsClient | undefined;

  constructor(options: GoldenRunnerOptions) {
    this.runtime = new TuttiRuntime(options.score);
    this.store = options.store;
    this.embeddingsClient = options.embeddingsClient;

    if (SecretsManager.optional("TUTTI_TEST_MODE")) {
      logger.info(
        "TUTTI_TEST_MODE is set — the GoldenRunner will invoke the provider " +
          "configured on the score (expected to be a mock in test mode).",
      );
    }
  }

  async runGoldenCase(goldenCase: GoldenCase): Promise<GoldenRun> {
    const toolSequence = this.captureToolSequence();

    const ran_at = new Date();
    const { output, tokens, cost_usd } = await this.executeAgent(goldenCase);
    toolSequence.stop();

    const scores = await this.runScorers(goldenCase, output, toolSequence.seq);
    const passed = Object.values(scores).every((s) => s.passed);
    const diff = computeDiff(goldenCase, output);

    const run: GoldenRun = {
      id: "",
      case_id: goldenCase.id,
      ran_at,
      output,
      tool_sequence: toolSequence.seq,
      tokens,
      ...(cost_usd !== undefined ? { cost_usd } : {}),
      scores,
      passed,
      ...(diff !== undefined ? { diff } : {}),
    };

    return this.store ? this.store.saveRun(run) : run;
  }

  /** Wire a `tool:start` listener, return the mutable sequence + unsubscribe. */
  private captureToolSequence(): { seq: string[]; stop: () => void } {
    const seq: string[] = [];
    const unsub = this.runtime.events.on("tool:start", (e) => {
      seq.push(e.tool_name);
    });
    return { seq, stop: unsub };
  }

  private async executeAgent(
    goldenCase: GoldenCase,
  ): Promise<{ output: string; tokens: number; cost_usd: number | undefined }> {
    try {
      const result = await this.runtime.run(goldenCase.agent_id, goldenCase.input);
      const tokens = result.usage.input_tokens + result.usage.output_tokens;
      return {
        output: result.output,
        tokens,
        cost_usd: result.usage.cost_usd,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: "[error] " + msg, tokens: 0, cost_usd: undefined };
    }
  }

  private async runScorers(
    goldenCase: GoldenCase,
    output: string,
    tool_sequence: string[],
  ): Promise<Record<string, ScoreResult>> {
    const scorerInput: ScorerInput = {
      input: goldenCase.input,
      output,
      tool_sequence,
      ...(goldenCase.expected_output !== undefined
        ? { expected_output: goldenCase.expected_output }
        : {}),
      ...(goldenCase.expected_tool_sequence !== undefined
        ? { expected_tool_sequence: goldenCase.expected_tool_sequence }
        : {}),
      ...(goldenCase.expected_structured !== undefined
        ? { expected_structured: goldenCase.expected_structured }
        : {}),
    };

    const out: Record<string, ScoreResult> = {};
    for (const ref of goldenCase.scorers) {
      const scorer: Scorer = resolveScorer(ref, {
        ...(this.embeddingsClient ? { embeddingsClient: this.embeddingsClient } : {}),
      });
      out[scorer.name] = await scorer.score(scorerInput);
    }
    return out;
  }
}

/**
 * Unified-format text diff of `expected` vs `actual`, or `undefined`
 * when the case has no expected output. Uses {@link createTwoFilesPatch}
 * from the `diff` package. Labels are fixed (`expected` / `actual`) so
 * downstream viewers know which side is which regardless of who wrote
 * the case.
 */
export function computeDiff(
  goldenCase: GoldenCase,
  actual: string,
): string | undefined {
  if (goldenCase.expected_output === undefined) return undefined;
  if (goldenCase.expected_output === actual) return undefined;
  return createTwoFilesPatch(
    "expected",
    "actual",
    goldenCase.expected_output,
    actual,
    undefined,
    undefined,
    { context: 3 },
  );
}

/**
 * Functional sugar — constructs a {@link GoldenRunner} for a single run
 * and returns the resulting {@link GoldenRun}. Matches the spec's
 * `runGoldenCase(case, options)` signature. Prefer the class form when
 * running many cases against the same score (reuses the runtime).
 */
export async function runGoldenCase(
  goldenCase: GoldenCase,
  options: GoldenRunnerOptions,
): Promise<GoldenRun> {
  return new GoldenRunner(options).runGoldenCase(goldenCase);
}
