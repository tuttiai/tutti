/**
 * Render ranked definitions as a compact map within a token budget.
 */

import type { RankedDefinition } from "./rank.js";

/** Characters per token assumed when estimating size. */
export const CHARS_PER_TOKEN = 4;

/** Facts the closing lines report. */
export interface RenderStats {
  /** Files that were tagged. */
  files: number;
  /** Notes to append, such as a time limit having been reached. */
  notes: readonly string[];
}

/**
 * Estimate a text's size in tokens.
 *
 * @param text - Any text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function body(ranked: readonly RankedDefinition[]): string {
  const byFile = new Map<string, RankedDefinition[]>();
  // Files appear in the order of their best definition; a file's own
  // definitions are listed in source order.
  for (const r of ranked) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r]);
  const blocks = [...byFile].map(([path, defs]) => {
    const lines = defs
      .sort((a, b) => a.definition.line - b.definition.line)
      .map((d) => `  ${d.definition.line}: ${d.definition.signature}`);
    return [path, ...lines].join("\n");
  });
  return blocks.join("\n");
}

function footer(shown: readonly RankedDefinition[], total: number, stats: RenderStats): string {
  const files = new Set(shown.map((r) => r.path)).size;
  const leftFiles = stats.files - files;
  const leftDefs = total - shown.length;
  const lines = [
    `[${leftFiles} files and ${leftDefs} definitions left out. ` +
      "Pass focus (file paths or names) or a larger max_tokens to see others.]",
    ...stats.notes,
  ];
  return lines.join("\n");
}

/**
 * Render the map: each file's path, then its chosen definitions indented
 * with their line numbers, then a line saying what was left out.
 *
 * The most definitions that fit within `maxTokens` are found by binary
 * search over how many of the ranked list to show.
 *
 * @param ranked - Definitions, best first.
 * @param maxTokens - Token budget for the whole output.
 * @param stats - Totals and notes for the closing lines.
 * @returns The map text.
 */
export function renderMap(
  ranked: readonly RankedDefinition[],
  maxTokens: number,
  stats: RenderStats,
): string {
  const render = (n: number): string => {
    const shown = ranked.slice(0, n);
    const text = body(shown);
    return (text ? text + "\n" : "") + footer(shown, ranked.length, stats);
  };
  let lo = 0;
  let hi = ranked.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(render(mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return render(lo);
}
