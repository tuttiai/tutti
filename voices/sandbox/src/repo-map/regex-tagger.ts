/**
 * A line-based tagger for languages without a tree-sitter grammar here
 * (Swift, Kotlin), and the fallback for any file tree-sitter cannot read.
 *
 * Each rule matches one definition at the start of a line, after any
 * modifiers. References are every identifier-shaped word that is not a
 * keyword, which over-counts slightly (comments and strings are included)
 * but only ever adds edges to names some file really defines.
 */

import { toSignature } from "./types.js";
import type { Definition, DefinitionKind, FileTags, LanguageId } from "./types.js";

interface Rule {
  re: RegExp;
  kind: DefinitionKind | ((keyword: string) => DefinitionKind);
}

const SWIFT_MODS =
  "(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|fileprivate|internal|open|final|static|" +
  "override|mutating|nonmutating|convenience|required|indirect|nonisolated|dynamic|" +
  "class|package)(?:\\([^)]*\\))?\\s+)*";
const KOTLIN_MODS =
  "(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|internal|protected|override|open|" +
  "abstract|final|suspend|inline|operator|infix|tailrec|external|actual|expect|data|" +
  "sealed|inner|enum|annotation|companion|value|const|lateinit|fun)\\s+)*";
const GENERIC_MODS =
  "(?:(?:export|default|public|private|protected|static|abstract|final|async|declare|pub)\\s+)*";

const SWIFT_TYPES = new Map<string, DefinitionKind>([
  ["class", "class"], ["struct", "struct"], ["enum", "enum"], ["protocol", "protocol"],
  ["actor", "class"], ["typealias", "type"],
]);
const KOTLIN_TYPES = new Map<string, DefinitionKind>([
  ["class", "class"], ["interface", "interface"], ["object", "class"], ["typealias", "type"],
]);
const GENERIC_TYPES = new Map<string, DefinitionKind>([
  ["class", "class"], ["interface", "interface"], ["struct", "struct"], ["enum", "enum"],
  ["trait", "trait"], ["type", "type"],
]);

function keywordKind(table: ReadonlyMap<string, DefinitionKind>): (k: string) => DefinitionKind {
  return (k) => table.get(k) ?? "type";
}

const RULES = new Map<LanguageId | "generic", Rule[]>([
  ["swift", [
    { re: new RegExp(`^\\s*${SWIFT_MODS}func\\s+([A-Za-z_]\\w*)`), kind: "function" },
    { re: new RegExp(`^\\s*${SWIFT_MODS}(class|struct|enum|protocol|actor|typealias)\\s+([A-Za-z_]\\w*)`), kind: keywordKind(SWIFT_TYPES) },
  ]],
  ["kotlin", [
    { re: new RegExp(`^\\s*${KOTLIN_MODS}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>, ?*]+\\.)?([A-Za-z_]\\w*)\\s*\\(`), kind: "function" },
    { re: new RegExp(`^\\s*${KOTLIN_MODS}(class|interface|object|typealias)\\s+([A-Za-z_]\\w*)`), kind: keywordKind(KOTLIN_TYPES) },
  ]],
  ["generic", [
    { re: new RegExp(`^\\s*${GENERIC_MODS}(?:function\\*?|def|func|fn|fun)\\s+(?:\\([^)]*\\)\\s*)?([A-Za-z_$][\\w$]*)`), kind: "function" },
    { re: new RegExp(`^\\s*${GENERIC_MODS}(class|interface|struct|enum|trait|type)\\s+([A-Za-z_$][\\w$]*)`), kind: keywordKind(GENERIC_TYPES) },
  ]],
]);

const KEYWORDS = new Set(
  ("if else for while do switch case default break continue return func function fun def " +
    "class struct enum protocol interface extension import export from package let var val " +
    "const static public private protected internal open final override true false nil null " +
    "none None True False self Self this super new try catch throw throws finally async await " +
    "guard in is as and or not where with yield lambda pass raise elif type typealias object " +
    "init deinit get set void").split(" "),
);

function matchLine(rules: Rule[], line: string): [string, DefinitionKind] | undefined {
  for (const rule of rules) {
    const m = rule.re.exec(line);
    if (!m) continue;
    const name = m.at(-1);
    if (!name) continue;
    const kind = typeof rule.kind === "function" ? rule.kind(m[1] ?? "") : rule.kind;
    return [name, kind];
  }
  return undefined;
}

function countIdentifiers(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [word] of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (word.length < 2 || KEYWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tag one file with line-based patterns.
 *
 * @param language - The file's language. Swift and Kotlin have their own
 *                   rules; any other language gets the generic ones.
 * @param source - The file's text.
 * @returns Its definitions and the identifiers it uses.
 */
export function tagWithRegex(language: LanguageId, source: string): FileTags {
  const rules = RULES.get(language) ?? RULES.get("generic") ?? [];
  const definitions: Definition[] = [];
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    const hit = line.length <= 1000 ? matchLine(rules, line) : undefined;
    if (hit) definitions.push({ name: hit[0], kind: hit[1], line: i + 1, signature: toSignature(line) });
  });
  const counts = countIdentifiers(source);
  // A definition's own name on its line is not a use of it.
  for (const d of definitions) counts.set(d.name, (counts.get(d.name) ?? 0) - 1);
  const references = [...counts].filter(([, c]) => c > 0);
  return { language, definitions, references, tagger: "regex" };
}
