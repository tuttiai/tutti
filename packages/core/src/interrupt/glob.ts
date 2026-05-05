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

/**
 * Does `pattern` match `text`? `*` is the only special glyph. Implemented
 * with `String.split("*")` + `startsWith` / `endsWith` / `indexOf` —
 * deliberately no `RegExp`, so there's no ReDoS surface and no escape
 * function to maintain.
 */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  if (pattern === "*") return true;

  const segments = pattern.split("*");
  const first = segments.shift() ?? "";
  const last = segments.pop() ?? "";

  if (!text.startsWith(first)) return false;
  if (!text.endsWith(last)) return false;
  // The first and last anchors may overlap when the pattern is e.g.
  // `*foo*` and `text` is shorter than `first + last`.
  if (text.length < first.length + last.length) return false;

  let cursor = first.length;
  const upperBound = text.length - last.length;
  for (const middle of segments) {
    const idx = text.indexOf(middle, cursor);
    if (idx === -1 || idx + middle.length > upperBound) return false;
    cursor = idx + middle.length;
  }
  return true;
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
