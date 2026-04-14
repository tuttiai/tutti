import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  ScoreLoader,
  EvalRunner,
  printEvalTable,
  createLogger,
} from "@tuttiai/core";
import type { EvalSuite } from "@tuttiai/core";

const logger = createLogger("tutti-cli");

export async function evalCommand(suitePath: string, opts: { ci?: boolean; score?: string }): Promise<void> {
  const suiteFile = resolve(suitePath);
  if (!existsSync(suiteFile)) {
    logger.error({ file: suiteFile }, "Suite file not found");
    process.exit(1);
  }

  // Load the eval suite JSON
  let suite: EvalSuite;
  try {
    suite = JSON.parse(readFileSync(suiteFile, "utf-8")) as EvalSuite;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to parse suite file");
    process.exit(1);
  }

  // Load score
  const scoreFile = resolve(opts.score ?? "./tutti.score.ts");
  if (!existsSync(scoreFile)) {
    logger.error({ file: scoreFile }, "Score file not found");
    process.exit(1);
  }

  const spinner = ora("Loading score...").start();
  let score;
  try {
    score = await ScoreLoader.load(scoreFile);
  } catch (err) {
    spinner.fail("Failed to load score");
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Score load failed");
    process.exit(1);
  }
  spinner.succeed("Score loaded");

  // Run eval
  const evalSpinner = ora("Running " + suite.cases.length + " eval cases...").start();
  const runner = new EvalRunner(score);
  const report = await runner.run(suite);
  evalSpinner.stop();

  // Print results
  printEvalTable(report);

  // CI mode: exit 1 if any failed
  if (opts.ci && report.summary.failed > 0) {
    console.error(chalk.red("  CI mode: " + report.summary.failed + " case(s) failed"));
    process.exit(1);
  }
}
