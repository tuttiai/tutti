/**
 * The reference graph: an edge from file A to file B for every identifier
 * A uses that B defines, weighted the way Aider's repo map weights them.
 */

import type { TaggedFile } from "./types.js";

/** Names so common that a match on them says little about a dependency. */
const COMMON_NAMES = new Set(
  ("get set has add map run init call apply bind then catch push pop value name data key " +
    "id type error log length size toString valueOf main test describe it expect next start " +
    "stop close open read write update create delete handle process result options config")
    .split(" "),
);

/** What the caller is interested in. */
export interface Focus {
  files: ReadonlySet<string>;
  idents: ReadonlySet<string>;
}

/** Weighted edges and the weight each definition receives. */
export interface RefGraph {
  /** `edges.get(a).get(b)` is the total weight of A's uses of B's names. */
  edges: Map<string, Map<string, number>>;
  /** Incoming weight per definition, keyed `path\0name`. */
  defWeight: Map<string, number>;
}

/**
 * How much one identifier says about a dependency.
 *
 * Long camelCase, snake_case or kebab-case names and names the caller
 * asked about count for more; private-looking, short, very common and
 * many-times-defined names count for less.
 *
 * @param ident - The identifier.
 * @param definers - How many files define it.
 * @param focus - The caller's focus.
 */
export function identWeight(ident: string, definers: number, focus: Focus): number {
  let mul = 1;
  if (focus.idents.has(ident)) mul *= 10;
  const shaped = /[a-z][A-Z]/.test(ident) || /[a-zA-Z][_-][a-zA-Z]/.test(ident);
  if (ident.length >= 8 && shaped) mul *= 10;
  if (ident.startsWith("_")) mul *= 0.1;
  if (ident.length <= 3) mul *= 0.2;
  if (COMMON_NAMES.has(ident)) mul *= 0.1;
  if (definers > 5) mul *= 0.1;
  return mul;
}

function definersByName(files: readonly TaggedFile[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    for (const d of f.tags.definitions) {
      const set = out.get(d.name) ?? new Set<string>();
      set.add(f.path);
      out.set(d.name, set);
    }
  }
  return out;
}

function addEdge(graph: RefGraph, from: string, to: string, weight: number): void {
  const row = graph.edges.get(from) ?? new Map<string, number>();
  row.set(to, (row.get(to) ?? 0) + weight);
  graph.edges.set(from, row);
}

/**
 * Build the reference graph.
 *
 * @param files - Every tagged file.
 * @param focus - Files and identifiers the caller cares about.
 * @returns Weighted file-to-file edges and per-definition incoming weight.
 */
export function buildGraph(files: readonly TaggedFile[], focus: Focus): RefGraph {
  const definers = definersByName(files);
  const graph: RefGraph = { edges: new Map(), defWeight: new Map() };
  for (const file of files) {
    // A file the caller is working in makes what it uses matter more.
    const fromFocus = focus.files.has(file.path) ? 50 : 1;
    for (const [ident, count] of file.tags.references) {
      const owners = definers.get(ident);
      if (!owners) continue;
      const weight = identWeight(ident, owners.size, focus) * Math.sqrt(count) * fromFocus;
      for (const owner of owners) {
        if (owner === file.path) continue;
        addEdge(graph, file.path, owner, weight);
        const key = `${owner}\0${ident}`;
        graph.defWeight.set(key, (graph.defWeight.get(key) ?? 0) + weight);
      }
    }
  }
  return graph;
}
