/**
 * Fake keys in the five formats `SecretsManager` redacts, for the
 * secret-redaction tests.
 *
 * Every key is assembled at runtime from fragments so that no string that
 * looks like a real credential is committed: the repository is public and
 * GitHub push protection rejects a commit carrying a realistic `ghp_` token.
 * None of these values has ever been a live key.
 */

/** A run of letters and digits of exactly `length` characters. */
export function keyBody(length: number): string {
  return "a1B2".repeat(Math.ceil(length / 4)).slice(0, length);
}

/** One key format: a key main redacts and a near miss it must leave alone. */
export interface SecretFormat {
  /** Short name used in test titles. */
  readonly name: string;
  /** A fake key in this format that `SecretsManager.redact` matches. */
  readonly key: () => string;
  /** A string close to the format that is not a key and must survive. */
  readonly nearMiss: () => string;
}

/** The five formats covered by the redaction guarantee. */
export const SECRET_FORMATS: readonly SecretFormat[] = [
  {
    name: "sk-ant",
    key: () => "sk" + "-ant-api03-" + keyBody(24),
    nearMiss: () => "sk" + "-ant-" + keyBody(19),
  },
  {
    name: "sk",
    key: () => "sk" + "-" + keyBody(24),
    nearMiss: () => "sk" + "-" + keyBody(19),
  },
  {
    name: "ghp_",
    key: () => "gh" + "p_" + keyBody(36),
    nearMiss: () => "gh" + "p" + keyBody(36),
  },
  {
    name: "AIza",
    key: () => "AI" + "za" + keyBody(35),
    nearMiss: () => "AI" + "za" + keyBody(34),
  },
  {
    name: "Bearer",
    key: () => "Bea" + "rer " + keyBody(16) + "." + keyBody(8) + "-" + keyBody(4),
    nearMiss: () => "Bea" + "rer " + keyBody(19),
  },
];

/** Plain words that contain a key prefix and must never be redacted. */
export const PLAIN_WORDS: readonly string[] = [
  "task-runner",
  "skeleton",
  "risk-free",
  "Bearer token",
];

/** The marker `SecretsManager` writes in place of a key. */
export const REDACTED = "[REDACTED]";
