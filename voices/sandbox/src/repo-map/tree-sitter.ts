/**
 * Definitions and references through tree-sitter's WebAssembly build.
 *
 * Grammars are loaded on first use and kept for the life of the process,
 * so the cost of loading one is paid once, not per call.
 */

import { createRequire } from "node:module";

import { Language, Parser, Query } from "web-tree-sitter";
import type { Node, QueryMatch } from "web-tree-sitter";

import { logger } from "../logger.js";
import { IDENTIFIER_NODE_TYPES, TREE_SITTER_LANGUAGES } from "./queries.js";
import { DefinitionKindSchema, toSignature } from "./types.js";
import type { Definition, FileTags, LanguageId } from "./types.js";

interface Grammar {
  parser: Parser;
  query: Query;
}

let runtime: Promise<void> | undefined;
const grammars = new Map<LanguageId, Promise<Grammar | undefined>>();

// Only to locate the grammar files on disk: `import.meta.resolve` is not
// available under every runner (vitest's), and the package has no exports map.
const resolveFile = createRequire(import.meta.url).resolve;

/** Absolute path of a grammar file shipped by `@vscode/tree-sitter-wasm`. */
function grammarPath(file: string): string {
  return resolveFile(`@vscode/tree-sitter-wasm/wasm/${file}`);
}

async function loadGrammar(language: LanguageId): Promise<Grammar | undefined> {
  const spec = TREE_SITTER_LANGUAGES.get(language);
  if (!spec) return undefined;
  runtime ??= Parser.init();
  await runtime;
  const lang = await Language.load(grammarPath(spec.wasm));
  const parser = new Parser();
  parser.setLanguage(lang);
  return { parser, query: new Query(lang, spec.query) };
}

/**
 * Load, once, the grammar for a language.
 *
 * @param language - The language wanted.
 * @returns The parser and its definition query, or `undefined` when
 *          tree-sitter does not read this language or its grammar failed
 *          to load (the caller then falls back to the regex tagger).
 */
export async function grammarFor(language: LanguageId): Promise<Grammar | undefined> {
  let pending = grammars.get(language);
  if (!pending) {
    pending = loadGrammar(language).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ language, reason }, "repo_map: grammar did not load; using the regex tagger");
      return undefined;
    });
    grammars.set(language, pending);
  }
  return pending;
}

interface Found {
  definition: Definition;
  /** Byte offset of the name, so the name is not also counted as a use. */
  nameStart: number;
}

function definitionOf(match: QueryMatch, lines: readonly string[]): Found | undefined {
  const name = match.captures.find((c) => c.name === "name")?.node;
  const def = match.captures.find((c) => c.name.startsWith("definition."));
  const kind = DefinitionKindSchema.safeParse(def?.name.slice("definition.".length));
  if (!name || !kind.success) return undefined;
  const row = name.startPosition.row;
  const signature = toSignature(lines.at(row) ?? "");
  return {
    definition: { name: name.text, kind: kind.data, line: row + 1, signature },
    nameStart: name.startIndex,
  };
}

function collectDefinitions(grammar: Grammar, root: Node, source: string): Found[] {
  const lines = source.split("\n");
  const best = new Map<number, { found: Found; pattern: number }>();
  // Where two patterns match one name (an exported arrow function is also
  // an exported constant; a Go struct is also a type), the pattern written
  // first, the more specific one, wins.
  for (const match of grammar.query.matches(root)) {
    const found = definitionOf(match, lines);
    if (!found) continue;
    const held = best.get(found.nameStart);
    if (!held || match.patternIndex < held.pattern) {
      best.set(found.nameStart, { found, pattern: match.patternIndex });
    }
  }
  return [...best.values()].map((b) => b.found).sort((x, y) => x.nameStart - y.nameStart);
}

function collectReferences(root: Node, defined: ReadonlySet<number>): Map<string, number> {
  const counts = new Map<string, number>();
  const cursor = root.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (IDENTIFIER_NODE_TYPES.has(node.type) && !defined.has(node.startIndex)) {
        counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      }
      if (cursor.gotoFirstChild() || cursor.gotoNextSibling()) continue;
      let climbed = false;
      while (cursor.gotoParent()) {
        if (cursor.gotoNextSibling()) { climbed = true; break; }
      }
      if (!climbed) return counts;
    }
  } finally {
    cursor.delete();
  }
}

/**
 * Tag one file with tree-sitter.
 *
 * @param grammar - From {@link grammarFor}.
 * @param language - The file's language, recorded in the tags.
 * @param source - The file's text.
 * @returns Its definitions and the identifiers it uses, or `undefined`
 *          when the parse produced no tree.
 */
export function tagWithTreeSitter(
  grammar: Grammar,
  language: LanguageId,
  source: string,
): FileTags | undefined {
  const tree = grammar.parser.parse(source);
  if (!tree) return undefined;
  try {
    const found = collectDefinitions(grammar, tree.rootNode, source);
    const names = new Set(found.map((f) => f.nameStart));
    const references = [...collectReferences(tree.rootNode, names)];
    const definitions = found.map((f) => f.definition);
    return { language, definitions, references, tagger: "tree-sitter" };
  } finally {
    tree.delete();
  }
}
