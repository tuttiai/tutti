/**
 * Identifier safety helpers. Postgres does not let us parameterise
 * schema/table/column names — they have to be interpolated. To keep
 * that safe we (a) reject anything that isn't a plain ASCII identifier
 * and (b) double-quote the result with embedded `"` doubled (the SQL
 * standard escape).
 */

/** Strict identifier — letters, digits, underscores; cannot start with a digit. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Returns the input if it is a safe bare identifier, otherwise throws.
 * The thrown error is caught by the calling tool and turned into a
 * `ToolResult` so the agent gets a useful message.
 */
export function assertIdentifier(name: string, kind = "identifier"): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `Invalid ${kind} '${name}'. Must match /^[A-Za-z_][A-Za-z0-9_$]*$/ (no spaces, dots, or punctuation). To reference identifiers needing quoting, write them inline in raw SQL via the 'query' tool.`,
    );
  }
  return name;
}

/** Quote an identifier safely for direct interpolation. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * Quote a schema-qualified identifier of the form `schema.table` or
 * just `table`. Each segment is validated independently.
 */
export function quoteQualified(name: string, kind = "identifier"): string {
  const parts = name.split(".");
  if (parts.length > 2) {
    throw new Error(
      `Invalid ${kind} '${name}'. Use 'table' or 'schema.table'.`,
    );
  }
  return parts.map((p) => quoteIdent(assertIdentifier(p, kind))).join(".");
}
