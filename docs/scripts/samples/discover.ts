import { join } from "node:path";

/** The part of a directory entry the walk needs; `node:fs` Dirent satisfies it. */
export interface DirEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** The file-system calls the checker makes. The entry wires `node:fs`; tests pass a fake. */
export interface SamplesFs {
  readonly readdir: (dir: string) => Promise<readonly DirEntry[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
}

/** Directories under docs/ that hold installed or generated files, never pages. */
const SKIPPED = new Set(["node_modules", "dist", ".astro"]);
/** The workspace globs in the root package.json. */
const WORKSPACE_DIRS = ["packages", "voices"];

async function walk(fs: SamplesFs, root: string, dir: string, found: string[]): Promise<void> {
  for (const entry of await fs.readdir(join(root, dir))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(fs, root, path, found);
    else if (entry.isFile() && entry.name.endsWith(".mdx")) found.push(path);
  }
}

/**
 * Lists every .mdx file under docs/, skipping node_modules, dist and .astro. Symbolic links are
 * not followed.
 *
 * @param root - Absolute path of the repository root.
 * @param fs - The file-system calls to use.
 * @returns Paths relative to the root, with forward slashes, sorted.
 */
export async function listMdxFiles(root: string, fs: SamplesFs): Promise<string[]> {
  const found: string[] = [];
  await walk(fs, root, "docs", found);
  return found.sort();
}

function typesOf(text: string): string | null {
  try {
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest !== "object" || manifest === null || !("types" in manifest)) return null;
    return typeof manifest.types === "string" ? manifest.types : null;
  } catch {
    return null;
  }
}

async function missingIn(root: string, fs: SamplesFs, dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of await fs.readdir(join(root, dir))) {
    if (!entry.isDirectory()) continue;
    const pkg = `${dir}/${entry.name}`;
    const manifest = join(root, pkg, "package.json");
    const types = (await fs.exists(manifest)) ? typesOf(await fs.readFile(manifest)) : null;
    if (types !== null && !(await fs.exists(join(root, pkg, types)))) missing.push(pkg);
  }
  return missing;
}

/**
 * Finds workspace packages whose `types` file is missing, which means they have not been built.
 * Samples import the built declarations, so checking without them would only report hundreds of
 * "cannot find module" errors.
 *
 * @param root - Absolute path of the repository root.
 * @param fs - The file-system calls to use.
 * @returns The packages' paths relative to the root, such as `packages/core`.
 */
export async function missingBuilds(root: string, fs: SamplesFs): Promise<string[]> {
  const missing: string[] = [];
  for (const dir of WORKSPACE_DIRS) missing.push(...(await missingIn(root, fs, dir)));
  return missing;
}
