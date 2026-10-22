/**
 * File extension to language, and the path rules that keep vendored,
 * generated, lock, binary and build output out of the map.
 */

import { extname, basename } from "node:path";

import type { LanguageId } from "./types.js";

const EXTENSIONS = new Map<string, LanguageId>([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".py", "python"],
  [".go", "go"],
  [".php", "php"],
  [".swift", "swift"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
]);

/** Directory names never descended into: dependencies, build output, caches. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", ".tutti-cache", "node_modules", "bower_components",
  "jspm_packages", "vendor", "third_party", "third-party", "Pods",
  "Carthage", "DerivedData", ".build", ".gradle", ".idea", ".vscode", "dist",
  "build", "out", "target", "obj", "coverage", ".nyc_output", ".next",
  ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".venv", "venv",
  "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "site-packages",
  "generated", "__generated__", ".expo", "storybook-static",
]);

/** File name patterns that are generated or minified even in a source directory. */
const GENERATED_FILE = [
  /\.min\.(?:js|mjs|cjs)$/,
  /[.-]bundle\.(?:js|mjs)$/,
  /\.d\.ts$/,
  /\.generated\.\w+$/,
  /\.gen\.\w+$/,
  /_generated\.\w+$/,
  /\.pb\.go$/,
  /_pb2(?:_grpc)?\.py$/,
  /_string\.go$/,
  /^zz_generated/,
];

/**
 * Language of a file, judged by its extension.
 *
 * @param path - File path, relative or absolute.
 * @returns The language, or `undefined` when the map does not read it.
 */
export function languageFor(path: string): LanguageId | undefined {
  return EXTENSIONS.get(extname(path).toLowerCase());
}

/**
 * Whether a repository-relative path is left out of the map: inside an
 * ignored directory, generated, minified, or in a language the map does
 * not read (lock files, binaries and data files fall out here).
 *
 * @param relPath - Path relative to the mapped directory, `/`-separated.
 */
export function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.split("/");
  const name = basename(relPath);
  if (parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p))) return true;
  if (GENERATED_FILE.some((re) => re.test(name))) return true;
  return languageFor(name) === undefined;
}

/**
 * Whether a file's leading bytes look binary (a NUL byte in the first 8 KB).
 *
 * @param head - The start of the file.
 */
export function looksBinary(head: Uint8Array): boolean {
  return head.subarray(0, 8192).includes(0);
}
