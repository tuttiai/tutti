/**
 * Pure rendering functions for the `tutti-ai memory` command.
 *
 * Split from `memory.ts` so they stay in the coverage scope while the
 * Postgres I/O, Enquirer prompts, and process-exit handling stay
 * excluded.
 */

import chalk from "chalk";
import type { UserMemory, UserMemoryImportance } from "@tuttiai/core";

/** Visible width of an ANSI-coloured string. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
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

/** Render importance as a 3-star bar. */
export function importanceStars(importance: UserMemoryImportance): string {
  if (importance === 3) return "\u2605\u2605\u2605"; // ★★★
  if (importance === 2) return "\u2605\u2605\u2606"; // ★★☆
  return "\u2605\u2606\u2606"; // ★☆☆
}

/** Format a Date as a short `YYYY-MM-DD HH:MM` UTC string. */
function formatDate(d: Date): string {
  // toISOString → "2026-04-15T10:30:45.789Z"; slice "YYYY-MM-DD HH:MM".
  const iso = d.toISOString();
  return iso.slice(0, 10) + " " + iso.slice(11, 16);
}

/** Sort by importance DESC, then created_at DESC. Matches the spec for `list`. */
function sortMemoriesForList(memories: readonly UserMemory[]): UserMemory[] {
  return [...memories].sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.created_at.getTime() - a.created_at.getTime();
  });
}

/**
 * Render the per-memory table that `memory list` and `memory search`
 * share. `header` lets each command label its own context (the search
 * query, the user id, etc.) without duplicating column setup.
 */
function renderTable(
  memories: readonly UserMemory[],
  emptyMessage: string,
): string {
  if (memories.length === 0) return chalk.dim(emptyMessage);

  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.dim(
      "  " +
        pad("ID", 10) +
        pad("CONTENT", 62) +
        pad("SOURCE", 12) +
        pad("IMPORTANCE", 14) +
        "CREATED",
    ),
  );
  lines.push(chalk.dim("  " + "\u2500".repeat(110)));

  for (const m of memories) {
    const idShort = m.id.slice(0, 8);
    const content = truncate(m.content, 60);
    const sourceColored =
      m.source === "explicit" ? chalk.green("explicit") : chalk.yellow("inferred");
    const importance = importanceStars(m.importance);
    const created = formatDate(m.created_at);

    lines.push(
      "  " +
        chalk.bold(pad(idShort, 10)) +
        pad(content, 62) +
        pad(sourceColored, 12) +
        pad(importance, 14) +
        chalk.dim(created),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render every memory in the input as a table, sorted by
 * `(importance DESC, created_at DESC)` per the spec. `userId` is used
 * only for the empty-state message.
 */
export function renderMemoryList(
  memories: readonly UserMemory[],
  userId: string,
): string {
  return renderTable(
    sortMemoriesForList(memories),
    'No memories stored for user "' + userId + '".',
  );
}

/**
 * Render search results. The store has already ranked these by
 * relevance, so this preserves input order rather than re-sorting.
 * The header reproduces the query so output stays self-describing
 * when piped or redirected.
 */
export function renderMemorySearch(
  memories: readonly UserMemory[],
  userId: string,
  query: string,
): string {
  const header =
    chalk.dim(
      'Search for ' + chalk.bold('"' + query + '"') + ' in user "' + userId + '" — ' +
        memories.length + " result" + (memories.length === 1 ? "" : "s"),
    );
  const body = renderTable(
    memories,
    'No memories matching "' + query + '" for user "' + userId + '".',
  );
  return header + body;
}

/** Confirmation line shown after `memory add`. */
export function renderMemoryAdded(memory: UserMemory): string {
  return (
    chalk.green("✓") +
    " Stored memory " +
    chalk.bold(memory.id.slice(0, 8)) +
    chalk.dim(" (" + memory.source + ", " + importanceStars(memory.importance) + ")")
  );
}

/** Confirmation line shown after `memory delete`. */
export function renderMemoryDeleted(memoryId: string): string {
  return chalk.green("✓") + " Deleted memory " + chalk.bold(memoryId.slice(0, 8));
}

/** Confirmation line shown after `memory clear`. */
export function renderMemoryCleared(userId: string, count: number): string {
  return (
    chalk.green("✓") +
    " Deleted " +
    chalk.bold(String(count)) +
    " memor" +
    (count === 1 ? "y" : "ies") +
    ' for user "' + userId + '"'
  );
}

/* ------------------------------------------------------------------ */
/*  Export formats                                                     */
/* ------------------------------------------------------------------ */

/** Newline-suffixed JSON dump of the memories. Pretty-printed for diffability. */
export function exportMemoriesJson(memories: readonly UserMemory[]): string {
  return JSON.stringify(memories, null, 2) + "\n";
}

/**
 * RFC-4180-ish CSV: comma-separated, double-quote any field that
 * contains a comma / quote / newline; embedded quotes doubled. `tags`
 * is joined with `;` so it survives spreadsheet round-tripping.
 */
export function exportMemoriesCsv(memories: readonly UserMemory[]): string {
  const headers = [
    "id",
    "user_id",
    "content",
    "source",
    "importance",
    "tags",
    "created_at",
    "last_accessed_at",
    "expires_at",
  ];
  const rows: string[] = [headers.join(",")];

  for (const m of memories) {
    rows.push(
      [
        m.id,
        m.user_id,
        m.content,
        m.source,
        String(m.importance),
        m.tags?.join(";") ?? "",
        m.created_at.toISOString(),
        m.last_accessed_at?.toISOString() ?? "",
        m.expires_at?.toISOString() ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}
