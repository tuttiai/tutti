/**
 * Choose a tagger for a file: tree-sitter where a grammar is available
 * and parses it, the regex tagger otherwise.
 */

import { tagWithRegex } from "./regex-tagger.js";
import { grammarFor, tagWithTreeSitter } from "./tree-sitter.js";
import type { FileTags, LanguageId } from "./types.js";

/**
 * Tag one file's source.
 *
 * @param language - The file's language.
 * @param source - The file's text.
 * @returns Its definitions and the identifiers it uses.
 */
export async function tagSource(language: LanguageId, source: string): Promise<FileTags> {
  const grammar = await grammarFor(language);
  if (grammar) {
    try {
      const tags = tagWithTreeSitter(grammar, language, source);
      if (tags) return tags;
    } catch {
      // A grammar that throws on one file still reads the others; this
      // file gets the regex tagger.
    }
  }
  return tagWithRegex(language, source);
}
