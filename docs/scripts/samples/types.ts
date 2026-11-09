/** The language a counted block is type-checked as. `typescript` blocks count as `ts`. */
export type SampleLang = "ts" | "tsx";

/**
 * What identifies one sample, in the skip list and in output. `heading` is the slug of the
 * nearest heading above the block (see `slugify` in extract.ts), or `""` before the first one;
 * `index` is 1-based and counts only ts/tsx blocks under that heading, so adding a block in one
 * section does not move the keys of any other section.
 */
export interface SampleKey {
  /** Path of the .mdx file relative to the repository root, with forward slashes. */
  readonly file: string;
  readonly heading: string;
  readonly index: number;
}

/** One ts/tsx fenced block pulled out of an .mdx file. */
export interface Sample extends SampleKey {
  readonly lang: SampleLang;
  /** 1-based line in the .mdx file of the block's first content line. */
  readonly startLine: number;
  /** How many characters of indentation the opening fence had, removed from every content line. */
  readonly indent: number;
  /** The block's content, with the fence's indentation removed. */
  readonly code: string;
}

/** A TypeScript diagnostic placed in the .mdx file it came from. */
export interface SampleDiagnostic {
  /** 1-based line in the .mdx file. */
  readonly line: number;
  /** 1-based column in the .mdx file. */
  readonly column: number;
  /** The TS error number, for example 2339. */
  readonly code: number;
  /** The diagnostic's message chain, flattened to one line. */
  readonly message: string;
}

/** A sample and every diagnostic it produced; none means it type-checks. */
export interface SampleResult {
  readonly sample: Sample;
  readonly diagnostics: readonly SampleDiagnostic[];
}

/**
 * The stable string form of a sample key, used to match samples against the skip list.
 *
 * @param key - The file, heading and index.
 * @returns `file#heading#index`.
 */
export function keyOf(key: SampleKey): string {
  return `${key.file}#${key.heading}#${key.index}`;
}
