/**
 * Pure rendering for `tutti-ai eval list` — prints every golden case
 * alongside the pass/fail state of its latest recorded run.
 *
 * Split from the I/O orchestration so unit tests can exercise column
 * layout, empty state, and status colouring without touching disk.
 */

import chalk from "chalk";
import type { GoldenCase, GoldenRun, ScorerRef } from "@tuttiai/core";

/** Three possible verdicts for "has this case been run, and did it pass?". */
export type LastRunStatus = "pass" | "fail" | "never";

/** Visible width of a potentially ANSI-coloured string. */
function visibleLen(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Right-pad to `len`, accounting for ANSI escape sequences. */
function pad(s: string, len: number): string {
  const v = visibleLen(s);
  return v >= len ? s : s + " ".repeat(len - v);
}

/** Truncate text to `max` chars, appending `…` when cut. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "\u2026" : oneLine;
}

/** `YYYY-MM-DD HH:MM` UTC — same format used by `tutti-ai memory list`. */
function formatIsoShort(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 16);
}

/** Coerce the scorer list into a compact cell value like `exact,tool-sequence`. */
function scorersCell(scorers: ScorerRef[]): string {
  if (scorers.length === 0) return chalk.dim("(none)");
  return scorers.map((s) => s.type).join(",");
}

/** Colour the verdict word — green pass, red fail, dim never. */
function renderStatus(status: LastRunStatus): string {
  if (status === "pass") return chalk.green("pass");
  if (status === "fail") return chalk.red("FAIL");
  return chalk.dim("never");
}

/**
 * Map a case id to its last-run verdict. Wraps the per-case `latestRun`
 * lookup so the render layer doesn't touch the store.
 */
export function deriveLastRunStatus(latest: GoldenRun | null | undefined): LastRunStatus {
  if (!latest) return "never";
  return latest.passed ? "pass" : "fail";
}

/**
 * Render every golden case as a fixed-width table:
 *
 *     ID        NAME                        AGENT        SCORERS           STATUS  CREATED
 *     abcdef12  summarize Q1 report         assistant    exact,similarity  pass    2026-04-15 12:00
 *
 * Columns flex within per-column caps so short rows don't waste width on
 * a mostly-empty terminal. Empty input renders a single-line "no cases"
 * hint that points operators at the `record` flow.
 */
export function renderGoldenCasesTable(
  cases: GoldenCase[],
  latestByCaseId: Map<string, GoldenRun | null>,
): string {
  if (cases.length === 0) {
    return chalk.dim(
      "No golden cases recorded. Run `tutti-ai eval record <session-id>` to pin one.",
    );
  }

  const rows = cases.map((c) => ({
    id: c.id.slice(0, 8),
    name: truncate(c.name, 36),
    agent: truncate(c.agent_id, 16),
    scorers: truncate(scorersCell(c.scorers), 32),
    status: deriveLastRunStatus(latestByCaseId.get(c.id)),
    created: formatIsoShort(c.created_at),
  }));

  const widths = {
    id: 8,
    name: Math.max(4, ...rows.map((r) => visibleLen(r.name))),
    agent: Math.max(5, ...rows.map((r) => visibleLen(r.agent))),
    scorers: Math.max(7, ...rows.map((r) => visibleLen(r.scorers))),
    status: 6,
    created: 16,
  };

  const header =
    chalk.dim.bold(
      pad("ID", widths.id) +
        "  " +
        pad("NAME", widths.name) +
        "  " +
        pad("AGENT", widths.agent) +
        "  " +
        pad("SCORERS", widths.scorers) +
        "  " +
        pad("STATUS", widths.status) +
        "  " +
        pad("CREATED", widths.created),
    );

  const body = rows
    .map((r) =>
      pad(chalk.dim(r.id), widths.id) +
      "  " +
      pad(r.name, widths.name) +
      "  " +
      pad(chalk.cyan(r.agent), widths.agent) +
      "  " +
      pad(r.scorers, widths.scorers) +
      "  " +
      pad(renderStatus(r.status), widths.status) +
      "  " +
      pad(chalk.dim(r.created), widths.created),
    )
    .join("\n");

  return header + "\n" + body;
}
