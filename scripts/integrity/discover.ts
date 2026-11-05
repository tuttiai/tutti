import { join } from "node:path";

/** The part of a directory entry the scan needs. A `node:fs` Dirent satisfies it. */
export interface DirEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The file-system calls the scan makes, injected so tests touch no disk. */
export interface IntegrityFs {
  /** Lists a directory. Entries describe themselves; symlinks are not followed. */
  readonly readdir: (dir: string) => Promise<readonly DirEntry[]>;
  /** Reads a file as UTF-8 text. */
  readonly readFile: (path: string) => Promise<string>;
}

/** A config file in scope, or a symlinked workspace directory, which is reported and not entered. */
export interface ConfigFile {
  /** Relative to the repository root, with forward slashes: the path printed in a finding. */
  readonly path: string;
  /** The path to read. */
  readonly absolute: string;
  /** True when the entry is a symlink, which is reported and never followed. */
  readonly symlink: boolean;
}

/** Names a toolchain loads and runs: `*.config.*`, legacy `.eslintrc.*` and Vitest workspaces. */
export const CONFIG_NAME =
  /^(?:[^/]+\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc\.(?:js|cjs|mjs)|[^/]+\.workspace\.(?:js|mjs|ts))$/;

/** The directories whose immediate subdirectories are workspaces. */
export const WORKSPACE_PARENTS: readonly string[] = ["packages", "voices"];

/**
 * Directories scanned like a workspace although no workspace parent holds them. `docs/` is the
 * Astro site, and an `astro.config.mjs` is where the first dropper in these repos was planted.
 */
export const STANDALONE_DIRS: readonly string[] = ["docs"];

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readdirOrEmpty(fs: IntegrityFs, dir: string): Promise<readonly DirEntry[]> {
  try {
    return await fs.readdir(dir);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function configsIn(fs: IntegrityFs, root: string, dir: string): Promise<ConfigFile[]> {
  const entries = await readdirOrEmpty(fs, join(root, dir));
  return entries
    .filter((entry) => CONFIG_NAME.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      return { path, absolute: join(root, path), symlink: entry.isSymbolicLink() };
    });
}

interface Workspaces {
  readonly dirs: string[];
  readonly links: ConfigFile[];
}

async function workspaces(fs: IntegrityFs, root: string): Promise<Workspaces> {
  const dirs: string[] = [];
  const links: ConfigFile[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of await readdirOrEmpty(fs, join(root, parent))) {
      const path = `${parent}/${entry.name}`;
      if (entry.isSymbolicLink()) links.push({ path, absolute: join(root, path), symlink: true });
      else if (entry.isDirectory()) dirs.push(path);
    }
  }
  return { dirs, links };
}

function byPath(a: ConfigFile, b: ConfigFile): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/**
 * Lists every config file in scope: the root, `docs/`, then each `packages/*` and `voices/*` workspace, one
 * level deep. The depth is fixed rather than walked, so `node_modules`, `dist`, `scripts/` and
 * `tests/` are out of scope by construction and there is no ignore list for a dropper to join.
 * A symlinked config, and any symlink directly under `packages/` or `voices/`, is listed with
 * `symlink: true` and never followed: npm workspaces and turbo would follow a symlinked
 * workspace and load its configs, so skipping it quietly would hide them.
 *
 * @param root - Absolute path of the repository root.
 * @param fs - The file-system calls to use.
 * @returns The config files, sorted by path.
 */
export async function listConfigFiles(root: string, fs: IntegrityFs): Promise<ConfigFile[]> {
  const { dirs, links } = await workspaces(fs, root);
  const found: ConfigFile[] = [...links];
  for (const dir of ["", ...STANDALONE_DIRS, ...dirs]) {
    found.push(...(await configsIn(fs, root, dir)));
  }
  return found.sort(byPath);
}
