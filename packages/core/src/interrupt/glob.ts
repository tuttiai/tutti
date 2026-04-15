/**
 * Minimal glob matcher for `requireApproval` tool-name patterns.
 *
 * Supports exactly one wildcard: `*` matches any (possibly empty)
 * sequence of characters. Every other character is literal, including
 * `?`, `[`, `{`, etc. This deliberately sidesteps micromatch: a 5-line
 * helper beats ~1 MB of transitive dependencies for the one feature
 * we actually use.
 *
 * Examples:
 * - `"send_*"` matches `"send_email"` and `"send_"` but not `"resend_mail"`.
 * - `"*_admin"` matches `"delete_admin"` but not `"admin"`.
 * - `"payment_*"` matches `"payment_capture"`.
 * - `"delete_"` matches ONLY the exact name `"delete_"`.
 *
 * @module
 */

/** Escape every regex metacharacter *except* `*`. */
function escapeLiteral(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `pattern` match `text`? `*` is the only special glyph. */
export function globMatch(pattern: string, text: string): boolean {
  const rx = new RegExp("^" + escapeLiteral(pattern).replace(/\*/g, ".*") + "$");
  return rx.test(text);
}

/** True when `text` matches any of the patterns. Short-circuits on first hit. */
export function matchesAny(
  patterns: readonly string[],
  text: string,
): boolean {
  for (const p of patterns) {
    if (globMatch(p, text)) return true;
  }
  return false;
}
