/**
 * `tutti-ai eval run [--case <id>] [--tag <tag>] [--ci] [--fail-on-skip]`
 *
 * Loads every golden case from `.tutti/golden/`, runs each one through
 * `GoldenRunner` against the score's provider, and prints per-case
 * verdicts + a summary footer. In `--ci` mode writes JUnit XML to
 * `.tutti/eval-results.xml` and exits 1 if any case failed — suitable
 * for the GitHub Actions reporter (see `docs/examples/eval-ci.yml`).
 * The summary always prints how many scorer results were skipped;
 * `--fail-on-skip` turns those skips into failures and exits 1.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  GoldenRunner,
  JsonFileGoldenStore,
  ScoreLoader,
  type GoldenCase,
  type GoldenRun,
  type EmbeddingsClient,
  type GoldenStore,
} from "@tuttiai/core";
import type { ScoreConfig } from "@tuttiai/types";

import {
  computeStats,
  filterCases,
  renderCaseLine,
  renderCaseLineCI,
  renderSummary,
} from "./eval-run-render.js";
import { toJunitXml, type JunitRow } from "./eval-run-junit.js";
import { applySkipPolicy, countSkipped, renderSkippedLine, shouldFailRun } from "./eval-run-skips.js";
import { logger } from "../logger.js";

/** CLI flags for `tutti-ai eval run`. */
export interface EvalRunOptions {
  case?: string;
  tag?: string;
  ci?: boolean;
  score?: string;
  /** Fail the run (exit 1) when any scorer result was skipped. */
  failOnSkip?: boolean;
}

/** Structured result — returned so tests can assert without spying on exit. */
export interface EvalRunResult {
  passed: number;
  failed: number;
  total: number;
  /** Scorer results marked `skipped: true` across every case. */
  skipped: number;
  totalTokens: number;
  totalCostUsd: number;
  xmlPath?: string;
}

/** Default JUnit XML destination when `--ci` is set. */
export const DEFAULT_JUNIT_PATH = ".tutti/eval-results.xml";

/**
 * Injectable dependencies — production callers leave empty; tests pass
 * a pre-built score + in-memory store to skip score-file loading and
 * CWD resolution.
 */
export interface EvalRunDeps {
  score?: ScoreConfig;
  store?: GoldenStore;
  /** Override the JUnit XML path (still only written when `opts.ci`). */
  junitPath?: string;
  /** Embeddings client for the similarity scorer, so tests stay offline. */
  embeddingsClient?: EmbeddingsClient;
}

/**
 * Orchestration entry point. Always returns an {@link EvalRunResult};
 * exit codes are the caller's responsibility so tests can exercise the
 * full flow without spying on `process.exit`.
 */
export async function runEvalRun(
  opts: EvalRunOptions,
  deps: EvalRunDeps = {},
): Promise<EvalRunResult> {
  const store = deps.store ?? new JsonFileGoldenStore();
  const all = await store.listCases();
  const cases = filterCases(all, {
    ...(opts.case !== undefined ? { case: opts.case } : {}),
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
  });

  if (cases.length === 0) {
    console.log(
      chalk.dim(
        "No golden cases match the filter. Run `tutti-ai eval record <session-id>` first.",
      ),
    );
    return { passed: 0, failed: 0, total: 0, skipped: 0, totalTokens: 0, totalCostUsd: 0 };
  }

  const score = deps.score ?? (await loadScore(opts.score));
  const runner = new GoldenRunner({
    score,
    store,
    ...(deps.embeddingsClient !== undefined ? { embeddingsClient: deps.embeddingsClient } : {}),
  });

  const rows = await runCases(runner, cases, opts);
  const runs: GoldenRun[] = rows.map((r) => r.run);
  const stats = computeStats(runs);
  const skipped = countSkipped(runs);
  console.log(renderSummary(stats, !opts.ci));
  console.log(renderSkippedLine(skipped, opts.failOnSkip === true));

  let xmlPath: string | undefined;
  if (opts.ci) {
    xmlPath = resolve(deps.junitPath ?? DEFAULT_JUNIT_PATH);
    await writeJunitFile(xmlPath, rows);
  }

  return {
    passed: stats.passed,
    failed: stats.failed,
    total: stats.total,
    skipped,
    totalTokens: stats.totalTokens,
    totalCostUsd: stats.totalCostUsd,
    ...(xmlPath !== undefined ? { xmlPath } : {}),
  };
}

/** Commander-facing wrapper: prints, then exits 1 when {@link shouldFailRun} says so. */
export async function evalRunCommand(opts: EvalRunOptions): Promise<void> {
  const result = await runEvalRun(opts);
  if (shouldFailRun(opts, result)) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadScore(scorePath: string | undefined): Promise<Awaited<ReturnType<typeof ScoreLoader.load>>> {
  const path = resolve(scorePath ?? "./tutti.score.ts");
  const spinner = ora({ color: "cyan" }).start("Loading score...");
  try {
    const score = await ScoreLoader.load(path);
    spinner.stop();
    return score;
  } catch (err) {
    spinner.fail("Failed to load score");
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Score load error",
    );
    process.exit(1);
  }
}

/**
 * Run each case, apply the `--fail-on-skip` policy to the returned copy
 * (the runner has already saved the scorer's own verdict) and print it.
 */
async function runCases(
  runner: GoldenRunner,
  cases: GoldenCase[],
  opts: EvalRunOptions,
): Promise<JunitRow[]> {
  const rows: JunitRow[] = [];
  for (const c of cases) {
    const start = Date.now();
    const recorded = await runner.runGoldenCase(c);
    const durationMs = Date.now() - start;
    const run = applySkipPolicy(recorded, opts.failOnSkip === true);
    rows.push({ goldenCase: c, run, durationMs });
    printCaseResult(c, run, opts.ci === true);
  }
  return rows;
}

function printCaseResult(goldenCase: GoldenCase, run: GoldenRun, ci: boolean): void {
  if (ci) {
    console.log(renderCaseLineCI(goldenCase, run));
  } else {
    console.log(renderCaseLine(goldenCase, run));
  }
}

async function writeJunitFile(xmlPath: string, rows: JunitRow[]): Promise<void> {
  const xml = toJunitXml(rows);
  await mkdir(dirname(xmlPath), { recursive: true });
  await writeFile(xmlPath, xml, "utf8");
}
