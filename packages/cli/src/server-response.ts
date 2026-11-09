/**
 * Validation of the JSON bodies a running `tutti-ai serve` returns.
 *
 * The schemas come from `@tuttiai/types`; `@tuttiai/cli` does not declare
 * zod, so they are typed here structurally ({@link ResponseSchema}) and
 * only their `safeParse` is called. A body that fails to parse ends the
 * command with exit code 1 and an error naming the endpoint.
 *
 * The error never shows the body, a value from it or Zod's own messages
 * (some of which repeat the value received): only the issue path, the
 * issue code and, for type errors, the expected and received type names.
 * Paths are stripped of control characters and cut to a fixed length.
 */

import chalk from "chalk";

const MAX_ISSUE_LINES = 5;
const MAX_PATH_CHARS = 200;
const TYPE_NAME = /^[a-z]{1,16}$/;
const ISSUE_CODE = /^[a-z_]{1,32}$/;
const NOT_JSON = "  - response body is not valid JSON";
const HINT =
  "The server and this CLI may be on different versions. " +
  "Check the server URL, then upgrade @tuttiai/cli or the server so they match.";

/** One validation issue, reduced to the fields that are safe to print. */
export interface ResponseIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly expected?: unknown;
  readonly received?: unknown;
}

/** The part of a Zod schema this module uses; any `@tuttiai/types` response schema fits. */
export interface ResponseSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly ResponseIssue[] } };
}

/** Where a response came from: `endpoint` is the method and path only, never a host or query. */
export interface ResponseSource {
  readonly endpoint: string;
  readonly status: number;
}

function isPrintable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
  // Zero-width and bidirectional controls can disguise what a terminal shows.
  return !((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069));
}

/**
 * Render an issue path as safe, printable text: control characters
 * (including the ESC that starts an ANSI sequence) removed, cut to 200
 * characters, and `(root)` when empty.
 */
export function formatIssuePath(path: ReadonlyArray<string | number>): string {
  const clean = Array.from(path.map(String).join(".")).filter(isPrintable);
  const cut = clean.slice(0, MAX_PATH_CHARS).join("");
  return cut === "" ? "(root)" : cut;
}

function isTypeName(value: unknown): value is string {
  return typeof value === "string" && TYPE_NAME.test(value);
}

/**
 * One issue as `<path>: expected <type>, received <type>` for a type
 * error, or `<path>: <code>` for anything else. Never includes a value.
 */
export function formatIssue(issue: ResponseIssue): string {
  const path = formatIssuePath(issue.path);
  if (issue.code === "invalid_type" && isTypeName(issue.expected) && isTypeName(issue.received)) {
    return path + ": expected " + issue.expected + ", received " + issue.received;
  }
  return path + ": " + (ISSUE_CODE.test(issue.code) ? issue.code : "invalid");
}

/** The indented issue lines of the error: at most five, then `(and N more)`. */
export function formatIssues(issues: readonly ResponseIssue[]): string[] {
  const lines = issues.slice(0, MAX_ISSUE_LINES).map((issue) => "  - " + formatIssue(issue));
  if (issues.length > MAX_ISSUE_LINES) {
    lines.push("  - (and " + String(issues.length - MAX_ISSUE_LINES) + " more)");
  }
  return lines;
}

/** Print the malformed-response error to stderr and exit with code 1. */
export function failResponse(source: ResponseSource, lines: readonly string[]): never {
  console.error(
    chalk.red("Error: unexpected response from " + source.endpoint + " (HTTP " + String(source.status) + ")."),
  );
  console.error(chalk.dim(HINT));
  for (const line of lines) console.error(chalk.dim(line));
  process.exit(1);
}

/**
 * Read a response body as JSON. An empty body reads as `null`. A body
 * that is not JSON fails the command when the status is 2xx, and reads
 * as `null` otherwise so the caller's status handling still runs.
 */
export async function readServerJson(res: Response, endpoint: string): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    if (!res.ok) return null;
    return failResponse({ endpoint, status: res.status }, [NOT_JSON]);
  }
}

/** Validate parsed data against a schema, or fail the command naming the endpoint. */
export function expectShape<T>(data: unknown, schema: ResponseSchema<T>, source: ResponseSource): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  return failResponse(source, formatIssues(result.error.issues));
}

/** Read, parse and validate a 2xx response in one step. */
export async function parseServerResponse<T>(
  res: Response,
  schema: ResponseSchema<T>,
  endpoint: string,
): Promise<T> {
  const data = await readServerJson(res, endpoint);
  return expectShape(data, schema, { endpoint, status: res.status });
}
