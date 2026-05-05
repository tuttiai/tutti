/**
 * Pure rendering functions for the `tutti-ai interrupts` command.
 *
 * Split from `interrupts.ts` so they stay under coverage while the
 * HTTP fetching, raw-stdin keypress loop, and interval polling stay
 * excluded.
 */

import chalk from "chalk";
import type { InterruptRequest } from "@tuttiai/core";

/** Visible width of an ANSI-coloured string. */
function visibleLen(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Right-pad to `len` accounting for ANSI escape sequences. */
function pad(s: string, len: number): string {
  const v = visibleLen(s);
  return v >= len ? s : s + " ".repeat(len - v);
}

/** Truncate text to `max` chars, appending `…` when cut. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "\u2026" : oneLine;
}

/** `YYYY-MM-DD HH:MM:SS` UTC string — used in the detail view. */
function formatIsoShort(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
}

/**
 * "5s ago" / "2m ago" / "1h ago" / "3d ago". `now` is injected so tests
 * can pin it — production callers pass `new Date()` every render.
 *
 * Future times (`requested_at > now`) render as "now" rather than
 * negative values; small clock skews between server and client should
 * not surface as "-3s ago".
 */
export function formatRelativeTime(requested_at: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - requested_at.getTime();
  if (diffMs < 0) return "now";

  const s = Math.floor(diffMs / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

/**
 * JSON-stringify `tool_args` and truncate to `max` chars. Used for the
 * per-row args preview. Handles unstringifiable values (circular refs,
 * BigInts) by falling back to `String()`.
 */
export function truncateArgs(tool_args: unknown, max = 80): string {
  let json: string;
  try {
    json = JSON.stringify(tool_args);
  } catch {
    json = String(tool_args);
  }
  if (json === undefined) return "";
  return truncate(json, max);
}

/**
 * Render the pending-interrupts table. Empty input renders an
 * "all clear" message. Sort order is the caller's responsibility
 * (the server returns oldest-first) — this function preserves input
 * order so a refresh doesn't reshuffle the list out from under the
 * reviewer.
 */
export function renderInterruptsList(
  interrupts: readonly InterruptRequest[],
  now: Date = new Date(),
): string {
  if (interrupts.length === 0) {
    return chalk.dim("No pending interrupts.");
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.dim(
      "  " +
        pad("ID", 10) +
        pad("SESSION", 14) +
        pad("TOOL", 22) +
        pad("ARGS", 52) +
        "AGE",
    ),
  );
  lines.push(chalk.dim("  " + "\u2500".repeat(110)));

  for (const r of interrupts) {
    const idShort = r.interrupt_id.slice(0, 8);
    const sessionShort = r.session_id.slice(0, 12);
    const toolName = truncate(r.tool_name, 20);
    const argsPreview = truncateArgs(r.tool_args, 50);
    const age = formatRelativeTime(r.requested_at, now);

    lines.push(
      "  " +
        chalk.bold(pad(idShort, 10)) +
        pad(sessionShort, 14) +
        pad(chalk.cyan(toolName), 22) +
        pad(chalk.dim(argsPreview), 52) +
        chalk.dim(age),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Detail view for a single interrupt. Shows the full metadata and
 * pretty-printed tool args. Called when the reviewer selects a row in
 * the interactive TUI.
 */
export function renderInterruptDetail(
  interrupt: InterruptRequest,
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold("Interrupt ") + chalk.dim(interrupt.interrupt_id));
  lines.push(chalk.dim("\u2500".repeat(60)));
  lines.push(chalk.dim("Session:     ") + interrupt.session_id);
  lines.push(chalk.dim("Tool:        ") + chalk.cyan(interrupt.tool_name));
  lines.push(
    chalk.dim("Requested:   ") +
      formatIsoShort(interrupt.requested_at) +
      chalk.dim(" (" + formatRelativeTime(interrupt.requested_at, now) + ")"),
  );
  lines.push(chalk.dim("Status:      ") + colorStatus(interrupt.status));
  if (interrupt.resolved_at) {
    lines.push(chalk.dim("Resolved:    ") + formatIsoShort(interrupt.resolved_at));
  }
  if (interrupt.resolved_by) {
    lines.push(chalk.dim("Resolved by: ") + interrupt.resolved_by);
  }
  if (interrupt.denial_reason) {
    lines.push(chalk.dim("Reason:      ") + interrupt.denial_reason);
  }
  lines.push("");
  lines.push(chalk.dim("Arguments:"));
  lines.push(prettyJson(interrupt.tool_args));
  lines.push("");
  return lines.join("\n");
}

/** Pretty-print `value` with stable indentation; falls back on errors. */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function colorStatus(status: InterruptRequest["status"]): string {
  if (status === "approved") return chalk.green("approved");
  if (status === "denied") return chalk.red("denied");
  return chalk.yellow("pending");
}

/** Confirmation line printed after a successful approve. */
export function renderApproved(interrupt: InterruptRequest): string {
  return (
    chalk.green("\u2713") +
    " Approved " +
    chalk.bold(interrupt.interrupt_id.slice(0, 8)) +
    chalk.dim(" (" + interrupt.tool_name + ")") +
    (interrupt.resolved_by ? chalk.dim(" by " + interrupt.resolved_by) : "")
  );
}

/** Confirmation line printed after a successful deny. */
export function renderDenied(interrupt: InterruptRequest): string {
  return (
    chalk.red("\u2717") +
    " Denied " +
    chalk.bold(interrupt.interrupt_id.slice(0, 8)) +
    chalk.dim(" (" + interrupt.tool_name + ")") +
    (interrupt.denial_reason ? chalk.dim(' — "' + interrupt.denial_reason + '"') : "")
  );
}
