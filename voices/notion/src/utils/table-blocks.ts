import { inlineRichText } from "./inline-markdown.js";
import type { BlockInput } from "./line-blocks.js";
import type { RichTextRun } from "./rich-text.js";

/** Notion accepts at most this many children under one block, a table's rows included. */
export const MAX_CHILDREN = 100;

/** A table longer than this is split, each part repeating the header row. */
const BODY_ROWS_PER_TABLE = MAX_CHILDREN - 1;

/** What reading a table gave: its blocks, and the line after it. */
export interface TableRead {
  readonly blocks: BlockInput[];
  readonly next: number;
}

/** One separator cell: dashes, with an optional colon at either end for alignment. */
const SEPARATOR_CELL = /^:?-+:?$/;

/**
 * A table row's cells, split on every `|` that is not escaped, with the outer pipes dropped.
 * An escaped `\|` stays escaped, for the inline reader to turn back into a pipe.
 *
 * @param line - The row as written.
 * @returns Its cells, trimmed.
 *
 * @example
 * splitRow("| a | b \\| c |"); // ["a", "b \\| c"]
 */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < body.length; at += 1) {
    const char = body.charAt(at);
    if (char === "\\" && body.charAt(at + 1) === "|") {
      cell += "\\|";
      at += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** Whether a line can be a table row: it holds a pipe. */
function isRow(line: string | undefined): line is string {
  return line !== undefined && line.trim().length > 0 && line.includes("|");
}

/** Whether a line is a header separator such as `|---|:--:|`, of exactly `width` cells. */
function isSeparator(line: string | undefined, width: number): boolean {
  if (!isRow(line)) return false;
  const cells = splitRow(line);
  return cells.length === width && cells.every((cell) => SEPARATOR_CELL.test(cell));
}

/** One row as a `table_row` block, padded or cut to the table's width. */
function rowBlock(cells: readonly string[], width: number): BlockInput {
  const filled: RichTextRun[][] = [];
  for (let column = 0; column < width; column += 1) filled.push(inlineRichText(cells.at(column) ?? ""));
  return { object: "block", type: "table_row", table_row: { cells: filled } };
}

/** A `table` block over a header and some body rows. */
function tableBlock(header: BlockInput, body: readonly BlockInput[], width: number): BlockInput {
  return {
    object: "block",
    type: "table",
    table: { table_width: width, has_column_header: true, has_row_header: false, children: [header, ...body] },
  };
}

/**
 * Read a GitHub-style markdown table starting at `start`, if one does.
 *
 * A table is a header row, a separator row of dashes with as many cells, and every following line
 * that holds a pipe. Its width is the header's: shorter rows are padded with empty cells and
 * longer ones cut. Cells take inline formatting. Notion takes at most 100 rows under one table,
 * so a longer table is split into several, each repeating the header, rather than refused.
 *
 * @param lines - Every line of the text.
 * @param start - The line that may open a table.
 * @returns The table blocks and the line after the table, or `undefined` when no table starts here.
 *
 * @example
 * readTable(["| a | b |", "|---|---|", "| 1 | 2 |"], 0); // one table, next: 3
 */
export function readTable(lines: readonly string[], start: number): TableRead | undefined {
  const first = lines.at(start);
  if (!isRow(first)) return undefined;
  const headerCells = splitRow(first);
  const width = headerCells.length;
  if (!isSeparator(lines.at(start + 1), width)) return undefined;
  const header = rowBlock(headerCells, width);
  const body: BlockInput[] = [];
  let next = start + 2;
  for (let line = lines.at(next); isRow(line); line = lines.at(next)) {
    body.push(rowBlock(splitRow(line), width));
    next += 1;
  }
  const blocks: BlockInput[] = [];
  for (let from = 0; from === 0 || from < body.length; from += BODY_ROWS_PER_TABLE) {
    blocks.push(tableBlock(header, body.slice(from, from + BODY_ROWS_PER_TABLE), width));
  }
  return { blocks, next };
}
