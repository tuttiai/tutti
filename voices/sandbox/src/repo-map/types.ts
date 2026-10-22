/**
 * Shared shapes for the repository map. The cached form is validated with
 * Zod when it is read back from disk, so these types are derived from the
 * schemas rather than written beside them.
 */

import { z } from "zod";

/** Languages the map understands. */
export const LanguageIdSchema = z.enum([
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "php",
  "swift",
  "kotlin",
]);

/** A language the map understands. */
export type LanguageId = z.infer<typeof LanguageIdSchema>;

/** What a definition is. */
export const DefinitionKindSchema = z.enum([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "protocol",
  "trait",
  "enum",
  "type",
  "constant",
  "module",
]);

/** What a definition is. */
export type DefinitionKind = z.infer<typeof DefinitionKindSchema>;

/** One named definition in a file. */
export const DefinitionSchema = z.object({
  name: z.string(),
  kind: DefinitionKindSchema,
  /** 1-based line of the definition's name. */
  line: z.number().int().positive(),
  /** The source line the name is on, trimmed and capped. */
  signature: z.string(),
});

/** One named definition in a file. */
export type Definition = z.infer<typeof DefinitionSchema>;

/** Everything the map needs to know about one file. */
export const FileTagsSchema = z.object({
  language: LanguageIdSchema,
  definitions: z.array(DefinitionSchema),
  /** Identifier names the file uses, each with how often. */
  references: z.array(z.tuple([z.string(), z.number().int().positive()])),
  /** Which tagger produced these tags. */
  tagger: z.enum(["tree-sitter", "regex"]),
});

/** Everything the map needs to know about one file. */
export type FileTags = z.infer<typeof FileTagsSchema>;

/** A file's tags with the path they belong to, relative to the mapped directory. */
export interface TaggedFile {
  path: string;
  tags: FileTags;
}

/** Longest signature kept for a definition, in characters. */
export const MAX_SIGNATURE_CHARS = 100;

/**
 * Trim a source line into a one-line signature.
 *
 * @param line - The raw source line.
 * @returns The line without surrounding whitespace, capped with an ellipsis.
 */
export function toSignature(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SIGNATURE_CHARS) return trimmed;
  return trimmed.slice(0, MAX_SIGNATURE_CHARS - 1) + "…";
}
