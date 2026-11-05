import type { Finding } from "./types.js";

/**
 * Orders findings by path, then by line, a whole-file finding before line 1. Ties keep the
 * order the rules are listed in.
 *
 * @param findings - Findings in any order.
 * @returns A sorted copy.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

/**
 * Replaces every C0 and C1 control character, DEL included, with a `\u{..}` escape. A file name
 * is chosen by whoever committed it; printed raw, ESC or CR in it could rewrite the terminal or
 * the log line that reports it.
 *
 * @param path - A path as it is on disk.
 * @returns The path with control characters made visible.
 */
export function printablePath(path: string): string {
  return Array.from(path, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    return control ? `\\u{${code.toString(16)}}` : char;
  }).join("");
}

/**
 * Formats one finding as `<path>:<line> <RULE> len=<n>`, with `-` for a whole-file finding.
 * The line's content is never printed, and the path goes through {@link printablePath}: a
 * payload or a file name may carry terminal escape sequences.
 *
 * @param finding - The finding to format.
 * @returns One output line, without a newline.
 */
export function formatFinding(finding: Finding): string {
  const line = finding.line === null ? "-" : String(finding.line);
  return `${printablePath(finding.path)}:${line} ${finding.rule} len=${String(finding.length)}`;
}

/**
 * The summary when anything was found.
 *
 * @param findings - Every finding.
 * @param total - How many config files were in scope.
 * @returns `check:integrity: <F> finding(s) in <N> of <M> config files`.
 */
export function failureSummary(findings: readonly Finding[], total: number): string {
  const files = new Set(findings.map((finding) => finding.path)).size;
  return `check:integrity: ${String(findings.length)} finding(s) in ${String(files)} of ${String(total)} config files`;
}

/**
 * The summary when some files could not be read and nothing was found in the rest.
 *
 * @param unreadable - How many files could not be read.
 * @param total - How many config files were in scope.
 * @returns One output line.
 */
export function unreadableSummary(unreadable: number, total: number): string {
  return `check:integrity: ${String(unreadable)} of ${String(total)} config files could not be read`;
}

/**
 * The summary when every file was read and nothing was found.
 *
 * @param total - How many config files were scanned.
 * @returns `check:integrity: OK, <M> config files scanned, 0 findings`.
 */
export function cleanSummary(total: number): string {
  return `check:integrity: OK, ${String(total)} config files scanned, 0 findings`;
}
