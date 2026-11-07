/**
 * Identifier of each integrity rule. The first twelve are applied line by line; `FILE_SIZE` and
 * `SYMLINK` describe a whole file and are reported with no line number.
 */
export type RuleId =
  | "LONG_LINE"
  | "WHITESPACE_PAD"
  | "DYNAMIC_CODE"
  | "CHILD_PROCESS"
  | "NETWORK"
  | "FS_WRITE"
  | "SENSITIVE_PATH"
  | "ENCODED_BLOB"
  | "DECODE"
  | "CHARCODE"
  | "DYNAMIC_LOAD"
  | "OBFUSCATED_IDENT"
  | "FILE_SIZE"
  | "SYMLINK";

/** A rule applied to one line of a config file at a time. */
export interface LineRule {
  /** The identifier printed in a finding. */
  readonly id: RuleId;
  /** What the rule catches and why, for a reader of the table. */
  readonly description: string;
  /** True when the line breaks the rule. */
  readonly test: (line: string) => boolean;
}

/** One rule broken in one place. The content of the line is deliberately not kept. */
export interface Finding {
  /** Path relative to the repository root, with forward slashes. */
  readonly path: string;
  /** 1-based line number, or null for a rule about the whole file. */
  readonly line: number | null;
  /** The rule that was broken. */
  readonly rule: RuleId;
  /** Line length in UTF-16 code units; file size in bytes for `FILE_SIZE`; 0 for `SYMLINK`. */
  readonly length: number;
}
