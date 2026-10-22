/**
 * Turn file ranks into a ranked list of definitions.
 */

import type { Focus, RefGraph } from "./graph.js";
import type { Definition, TaggedFile } from "./types.js";

/** One definition with its score. */
export interface RankedDefinition {
  path: string;
  definition: Definition;
  score: number;
}

/**
 * Weight a definition nobody references still gets, so a focused or
 * highly ranked file's own definitions can be shown.
 */
const BASE_WEIGHT = 0.1;

/**
 * Score every definition as its file's rank times the weight of the edges
 * that reach it (plus a small base), times ten when its name is in focus.
 *
 * @param files - Every tagged file.
 * @param graph - From {@link buildGraph}.
 * @param context - File ranks and the caller's focus.
 * @returns Definitions, highest score first; ties by path, then line.
 */
export function rankDefinitions(
  files: readonly TaggedFile[],
  graph: RefGraph,
  context: { ranks: ReadonlyMap<string, number>; focus: Focus },
): RankedDefinition[] {
  const out: RankedDefinition[] = [];
  for (const file of files) {
    const fileRank = context.ranks.get(file.path) ?? 0;
    for (const definition of file.tags.definitions) {
      const incoming = graph.defWeight.get(`${file.path}\0${definition.name}`) ?? 0;
      const boost = context.focus.idents.has(definition.name) ? 10 : 1;
      out.push({ path: file.path, definition, score: fileRank * (incoming + BASE_WEIGHT) * boost });
    }
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.localeCompare(b.path) ||
      a.definition.line - b.definition.line,
  );
}
