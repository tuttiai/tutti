/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

const MAX_CELL_LENGTH = 200;

/** Render a single cell value as a short string for table output. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return truncate(value, MAX_CELL_LENGTH);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Buffer.isBuffer(value)) return `<bytea ${value.length}B>`;
  try {
    return truncate(JSON.stringify(value), MAX_CELL_LENGTH);
  } catch {
    return "<unprintable>";
  }
}

/**
 * Render a result set as a fixed-width text table.
 * Columns are sized to the widest entry but capped at MAX_CELL_LENGTH.
 * Empty result sets return a single line so callers can still read it.
 */
export function formatTable(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0) return "(no columns)";
  if (rows.length === 0) return `(no rows)\nColumns: ${columns.join(", ")}`;

  const cells: string[][] = rows.map((row) =>
    columns.map((c) => formatCell(row[c])),
  );

  const widths = columns.map((c, i) => {
    const headerW = c.length;
    let maxW = headerW;
    for (const row of cells) {
      const cell = row[i] ?? "";
      if (cell.length > maxW) maxW = cell.length;
    }
    return Math.min(maxW, MAX_CELL_LENGTH);
  });

  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const header = columns.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ");
  const lines: string[] = [header, sep];
  for (const row of cells) {
    lines.push(row.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | "));
  }
  return lines.join("\n");
}

/**
 * Format a pg error into a descriptive, user-fixable message.
 * pg throws a `DatabaseError` with `code` (5-char SQLSTATE), `severity`,
 * `detail`, `hint`, `position`, and `schema`/`table`/`column` fields.
 */
export function postgresErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const e = error as {
      code?: string;
      detail?: string;
      hint?: string;
      position?: string;
      schema?: string;
      table?: string;
      column?: string;
      severity?: string;
    };
    const code = e.code;
    const codePrefix = code ? `[${code}] ` : "";
    const detail = e.detail ? `\nDetail: ${e.detail}` : "";
    const hint = e.hint ? `\nHint: ${e.hint}` : "";

    if (code === "28P01" || code === "28000") {
      return `${codePrefix}Postgres authentication failed${where}.\nCheck the username and password in DATABASE_URL.`;
    }
    if (code === "3D000") {
      return `${codePrefix}Database does not exist${where}.\nCheck the dbname segment of DATABASE_URL.`;
    }
    if (code === "42P01") {
      return `${codePrefix}Relation does not exist${where}.${detail}\nThe table or view name is wrong, or it lives in a schema that is not on the search_path. Try qualifying as schema.table.`;
    }
    if (code === "42703") {
      return `${codePrefix}Column does not exist${where}.${detail}${hint}\nDouble-check the column name; pg is case-sensitive when identifiers are quoted.`;
    }
    if (code === "42501") {
      return `${codePrefix}Permission denied${where}.${detail}\nThe role lacks the privilege required by this statement (e.g. SELECT, INSERT). Grant it explicitly.`;
    }
    if (code === "42601") {
      return `${codePrefix}SQL syntax error${where}.${e.position ? ` Position: ${e.position}.` : ""}${detail}${hint}`;
    }
    if (code === "23505") {
      return `${codePrefix}Unique constraint violation${where}.${detail}`;
    }
    if (code === "23503") {
      return `${codePrefix}Foreign-key violation${where}.${detail}`;
    }
    if (code === "23502") {
      return `${codePrefix}Not-null violation${where}.${detail}`;
    }
    if (code === "53300") {
      return `${codePrefix}Too many connections${where}.\nIncrease the server's max_connections or reduce the voice's max_connections option (default 5).`;
    }
    if (code === "57014") {
      return `${codePrefix}Statement was cancelled because it exceeded the configured statement_timeout${where}.\nSimplify the query or raise statement_timeout_ms when constructing the voice.`;
    }
    if (code === "25006") {
      return `${codePrefix}Cannot execute write statements in a read-only transaction${where}.\nUse the 'execute' tool for INSERT/UPDATE/DELETE/DDL — the 'query' tool runs inside BEGIN READ ONLY.`;
    }

    const base = code ? `${codePrefix}Postgres error${where}: ${error.message}` : `Postgres error${where}: ${error.message}`;
    return `${base}${detail}${hint}`;
  }
  return String(error);
}
