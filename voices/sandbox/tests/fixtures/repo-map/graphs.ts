/**
 * Small tagged-file sets for the graph, ranking and rendering tests.
 */

import type { Definition, TaggedFile } from "../../../src/repo-map/types.js";

function def(name: string, line: number): Definition {
  return { name, kind: "function", line, signature: `export function ${name}() {` };
}

function file(path: string, defs: Definition[], refs: Array<[string, number]>): TaggedFile {
  return { path, tags: { language: "typescript", definitions: defs, references: refs, tagger: "tree-sitter" } };
}

/** `hub.ts` defines `sharedHelper`, used by three files; `leaf.ts` is used by one. */
export const HUB_AND_LEAVES: readonly TaggedFile[] = [
  file("hub.ts", [def("sharedHelper", 3), def("unusedThing", 9)], []),
  file("a.ts", [def("aMain", 1)], [["sharedHelper", 2]]),
  file("b.ts", [def("bMain", 1)], [["sharedHelper", 1], ["leafWorker", 1]]),
  file("c.ts", [def("cMain", 1)], [["sharedHelper", 4]]),
  file("leaf.ts", [def("leafWorker", 5)], []),
];

/** Many definitions, for budget tests. */
export const MANY_DEFINITIONS: readonly TaggedFile[] = Array.from({ length: 30 }, (_, i) =>
  file(`src/module-${i}.ts`, [def(`exportedFunctionNumber${i}`, i + 1)], [[`exportedFunctionNumber${(i + 1) % 30}`, 1]]),
);

/** One file that uses only its own definition. */
export const SELF_REFERENCING: readonly TaggedFile[] = [
  file("self.ts", [def("selfContained", 1)], [["selfContained", 3]]),
];
