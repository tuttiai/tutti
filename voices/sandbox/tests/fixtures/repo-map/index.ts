/**
 * Fixture repositories for the repo map tests. Each is a directory beside
 * this file, copied into a fresh temporary directory per test so a test
 * can change files without touching the fixture.
 */

import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Names of the fixture repositories. */
export type FixtureName = "ranking" | "focus" | "ignored" | "languages";

/** A temporary copy of a fixture, and where to put the tag cache. */
export interface FixtureCopy {
  root: string;
  repo: string;
  cacheDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Files that the repository's own .gitignore would keep out of git, and
 * files too large or binary to commit as fixtures, so they are written at
 * test time into the `ignored` fixture. Every one defines a function whose
 * name must never appear in a map.
 */
export const IGNORED_EXTRAS: ReadonlyArray<[string, string | Buffer]> = [
  ["node_modules/left-pad/index.js", "export function nodeModuleFunction() { return 1; }\n"],
  ["dist/bundle.js", "export function distFunction() { return 1; }\n"],
  ["vendor/lib/vendored.js", "export function vendorFunction() { return 1; }\n"],
  ["build/out.js", "export function buildFunction() { return 1; }\n"],
  ["src/binary-blob.ts", Buffer.from("export function binaryFunction() {}\n\0\0\0", "utf-8")],
  ["src/huge-module.ts", "export function hugeFunction() {}\n" + "// padding\n".repeat(20_000)],
];

/** Function names defined only in ignored files of the `ignored` fixture. */
export const IGNORED_NAMES = [
  "nodeModuleFunction", "distFunction", "vendorFunction", "buildFunction",
  "binaryFunction", "hugeFunction", "minifiedFunction", "declaredFunction",
  "lockedFunction", "notesFunction",
];

/**
 * Copy a fixture into a new temporary sandbox-like directory.
 *
 * @param name - Which fixture.
 * @returns The copy's paths and a cleanup function.
 */
export async function copyFixture(name: FixtureName): Promise<FixtureCopy> {
  const root = await mkdtemp(join(tmpdir(), "tutti-repomap-"));
  const repo = join(root, "repo");
  await cp(join(HERE, name), repo, { recursive: true });
  if (name === "ignored") {
    for (const [path, content] of IGNORED_EXTRAS) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
  }
  return {
    root,
    repo,
    cacheDir: join(root, ".tutti-cache", "repo-map"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Absolute path of a language sample in the `languages` fixture. */
export function languageSample(file: string): string {
  return join(HERE, "languages", file);
}
