/**
 * Validation of npm package specs (`name` or `name@version`) before they
 * reach a package manager.
 *
 * @remarks
 * This is a plain validator rather than a Zod schema because zod is not a
 * declared dependency of `@tuttiai/cli`, and declaring one is an owner
 * decision. The result has the same shape as Zod's `safeParse`, so a
 * schema can replace it without touching the callers.
 *
 * The character classes are allow-lists: whitespace, control characters
 * and every shell metacharacter (`; & | $ ( ) < > ' " % !`, the backtick
 * and the backslash) fail them, as do URLs and `git+`, `file:` and `npm:`
 * specs.
 */

const SEGMENT_PATTERN = /^[a-z0-9~][a-z0-9._~-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9.^~*+-]{1,64}$/;
const MAX_NAME_LENGTH = 214;

/** Hint shown to the user under an invalid package name. */
export const PACKAGE_SPEC_HINT =
  'Hint: use a voice name like "slack", a scoped package like "@acme/voice", or add a version like "@acme/voice@^1.2.0".';

/** A package spec that passed validation. */
export interface PackageSpec {
  /** The package name, with its scope if it has one. */
  name: string;
  /** The version, range or dist-tag after the last `@`, when one was given. */
  version?: string;
}

/** Result of {@link parsePackageSpec}, shaped like Zod's `safeParse`. */
export type PackageSpecResult =
  | { success: true; data: PackageSpec }
  | { success: false; error: string };

/**
 * Check that a string is a bare npm package name (no version).
 *
 * @param name - The candidate name, for example a key from package.json.
 * @returns `true` when the name follows npm's naming rules: at most 214
 *   characters, lowercase, an optional `@scope/`, and no leading `.`, `_`
 *   or `-` in the scope or the name.
 */
export function isValidPackageName(name: string): boolean {
  if (name.length > MAX_NAME_LENGTH) return false;
  if (!name.startsWith("@")) return SEGMENT_PATTERN.test(name);
  const slash = name.indexOf("/");
  return (
    slash > 1 &&
    SEGMENT_PATTERN.test(name.slice(1, slash)) &&
    SEGMENT_PATTERN.test(name.slice(slash + 1))
  );
}

/**
 * Parse and validate an npm package spec such as `@acme/voice@^1.2.0`.
 *
 * @param spec - The spec to check. The version is split off at the last
 *   `@` after the first character, so a scope is never read as a version.
 * @returns The name and optional version, or an error message.
 */
export function parsePackageSpec(spec: string): PackageSpecResult {
  if (spec.trim() === "") {
    return { success: false, error: "Package name is required." };
  }
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : undefined;
  const valid =
    isValidPackageName(name) && (version === undefined || VERSION_PATTERN.test(version));
  if (!valid) {
    return { success: false, error: `Invalid package name: ${JSON.stringify(spec)}` };
  }
  return { success: true, data: version === undefined ? { name } : { name, version } };
}
