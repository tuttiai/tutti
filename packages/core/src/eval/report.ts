/** Evaluation report formatting: table, JSON, Markdown. */

import type { EvalReport, EvalResult, EvalSummary } from "./types.js";

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

/** Format one result row, followed by a line per failed assertion and one for an error. */
function formatResultLines(r: EvalResult): string[] {
  const icon = r.passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const score = r.score.toFixed(2);
  const cost = "$" + r.cost_usd.toFixed(3);
  const lines = [
    "  " + icon +
    " " + pad(r.case_id, 10) +
    " " + pad(r.case_name, 28) +
    " " + pad(score, 6) +
    " " + r.turns + " turns" +
    "  " + cost,
  ];
  if (r.passed) return lines;

  for (const a of r.assertions) {
    if (!a.passed) {
      const desc = a.assertion.description ?? a.assertion.type + ": " + String(a.assertion.value);
      lines.push("    \x1b[31m↳ FAIL: " + desc + " (actual: " + String(a.actual).slice(0, 60) + ")\x1b[0m");
    }
  }
  if (r.error) {
    lines.push("    \x1b[31m↳ ERROR: " + r.error.slice(0, 80) + "\x1b[0m");
  }
  return lines;
}

/** Format the summary line: passed count, pass rate, average score and total cost. */
function formatSummary(summary: EvalSummary): string {
  const pct = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
  return (
    "  Results: " + summary.passed + "/" + summary.total + " passed (" + pct + "%)" +
    " | Avg: " + summary.avg_score.toFixed(2) +
    " | Total: $" + summary.total_cost_usd.toFixed(3)
  );
}

/**
 * Build the text printTable writes. Every line ends in "\n", one per
 * console.log call this replaced, so the output is unchanged byte for byte.
 */
function formatTable(report: EvalReport): string {
  const { results, summary } = report;
  const lines = [
    "",
    "  Eval suite: " + report.suite_name + " (" + summary.total + " cases)",
    "",
    ...results.flatMap((r) => formatResultLines(r)),
    "",
    formatSummary(summary),
    "",
  ];
  return lines.join("\n") + "\n";
}

/** Print a formatted results table to stdout. */
export function printTable(report: EvalReport): void {
  process.stdout.write(formatTable(report));
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
