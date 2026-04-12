/* eslint-disable no-console -- printTable is designed to output directly to stdout */
/** Evaluation report formatting — table, JSON, Markdown. */

import type { EvalReport } from "./types.js";

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

/** Print a formatted results table to stdout. */
export function printTable(report: EvalReport): void {
  const { results, summary } = report;

  console.log();
  console.log("  Eval suite: " + report.suite_name + " (" + summary.total + " cases)");
  console.log();

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const score = r.score.toFixed(2);
    const cost = "$" + r.cost_usd.toFixed(3);
    const line =
      "  " + icon +
      " " + pad(r.case_id, 10) +
      " " + pad(r.case_name, 28) +
      " " + pad(score, 6) +
      " " + r.turns + " turns" +
      "  " + cost;
    console.log(line);

    if (!r.passed) {
      for (const a of r.assertions) {
        if (!a.passed) {
          const desc = a.assertion.description ?? a.assertion.type + ": " + String(a.assertion.value);
          console.log("    \x1b[31m↳ FAIL: " + desc + " (actual: " + String(a.actual).slice(0, 60) + ")\x1b[0m");
        }
      }
      if (r.error) {
        console.log("    \x1b[31m↳ ERROR: " + r.error.slice(0, 80) + "\x1b[0m");
      }
    }
  }

  const pct = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  console.log();
  console.log(
    "  Results: " + summary.passed + "/" + summary.total + " passed (" + pct + "%)" +
    " | Avg: " + summary.avg_score.toFixed(2) +
    " | Total: $" + summary.total_cost_usd.toFixed(3),
  );
  console.log();
}

/** Convert report to a plain JSON object for storage or CI. */
export function toJSON(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

/** Convert report to a GitHub-friendly markdown table. */
export function toMarkdown(report: EvalReport): string {
  const { results, summary } = report;
  const lines: string[] = [];

  lines.push("## Eval: " + report.suite_name);
  lines.push("");
  lines.push("| Status | ID | Name | Score | Turns | Cost |");
  lines.push("|--------|-----|------|-------|-------|------|");

  for (const r of results) {
    const icon = r.passed ? "pass" : "FAIL";
    lines.push(
      "| " + icon +
      " | " + r.case_id +
      " | " + r.case_name +
      " | " + r.score.toFixed(2) +
      " | " + r.turns +
      " | $" + r.cost_usd.toFixed(3) + " |",
    );
  }

  lines.push("");
  const pct = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  lines.push(
    "**Results:** " + summary.passed + "/" + summary.total + " passed (" + pct + "%)" +
    " | Avg score: " + summary.avg_score.toFixed(2) +
    " | Total cost: $" + summary.total_cost_usd.toFixed(3),
  );

  // Failed assertion details
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push("### Failures");
    lines.push("");
    for (const r of failed) {
      lines.push("**" + r.case_id + "** — " + r.case_name);
      for (const a of r.assertions.filter((x) => !x.passed)) {
        const desc = a.assertion.description ?? a.assertion.type + ": " + String(a.assertion.value);
        lines.push("- " + desc + " (actual: `" + String(a.actual).slice(0, 80) + "`)");
      }
      if (r.error) lines.push("- Error: " + r.error);
      lines.push("");
    }
  }

  return lines.join("\n");
}
