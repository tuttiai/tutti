import { parseArgs } from "node:util";

/** The options of `npm run check:history`, once checked. */
export interface HistoryArgs {
  /** Rule (a) scans merges committed on or after this UTC day, or every merge when null. */
  readonly since: string | null;
  /** The branch or ref whose history is checked. */
  readonly ref: string;
}

/** The outcome of parsing: the options, or why they were refused. */
export type ParsedHistoryArgs =
  | { readonly ok: true; readonly args: HistoryArgs }
  | { readonly ok: false; readonly reason: string };

/** The usage line printed after any refused option. */
export const HISTORY_USAGE = "usage: npm run check:history [-- --since=YYYY-MM-DD] [--ref=<ref>]";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[A-Za-z0-9._/-]+$/;

/**
 * Whether the text is a real calendar day in `YYYY-MM-DD` form. `2026-02-30` matches the shape
 * but is refused, because `Date` would roll it over to March.
 *
 * @param text - The value given to `--since`.
 * @returns True for a real day.
 */
export function isCalendarDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Whether the text may be handed to git as a ref: letters, digits, `.`, `_`, `/` and `-`, and
 * no leading `-`, so it can never be read as an option.
 *
 * @param text - The value given to `--ref`.
 * @returns True when it is safe to pass on.
 */
export function isSafeRef(text: string): boolean {
  return REF.test(text) && !text.startsWith("-");
}

function readOptions(argv: readonly string[]): { since?: string; ref?: string } | null {
  try {
    // `as const` keeps the option types literal, which parseArgs needs to type its values.
    const options = { since: { type: "string" }, ref: { type: "string" } } as const;
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }).values;
  } catch {
    return null;
  }
}

/**
 * Parses and checks the command line. The values given are never echoed back: a refusal names
 * the option, not what was typed.
 *
 * @param argv - The arguments after the script name.
 * @returns The options, or the reason they were refused.
 */
export function parseHistoryArgs(argv: readonly string[]): ParsedHistoryArgs {
  const values = readOptions(argv);
  if (values === null) return { ok: false, reason: "unknown option or stray argument" };
  const since = values.since ?? null;
  if (since !== null && !isCalendarDate(since)) return { ok: false, reason: "--since must be a real date as YYYY-MM-DD" };
  const ref = values.ref ?? "main";
  if (!isSafeRef(ref)) return { ok: false, reason: "--ref may hold only letters, digits, . _ / - and not start with -" };
  return { ok: true, args: { since, ref } };
}
