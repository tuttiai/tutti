/**
 * List the source files under a directory: `git ls-files` when it is a git
 * work tree, so `.gitignore` is honoured, and a bounded walk otherwise.
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { childEnv } from "../utils/child-env.js";
import { IGNORED_DIRS, isIgnoredPath } from "./languages.js";

const run = promisify(execFile);

/** Options for {@link listSourceFiles}. */
export interface ListOptions {
  /** Absolute directory to list. */
  dir: string;
  /**
   * Directory git must not search above for a repository, normally the
   * sandbox root, so a stray repository outside the sandbox is never read.
   */
  ceiling: string;
  /** Most files to return. */
  limit: number;
}

/** Files found, relative to the listed directory and `/`-separated. */
export interface ListResult {
  files: string[];
  /** Source files found beyond `limit` and dropped. */
  dropped: number;
  source: "git" | "walk";
}

async function gitFiles(opts: ListOptions): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: opts.dir,
        env: childEnv({ GIT_CEILING_DIRECTORIES: dirname(opts.ceiling) }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
      },
    );
    return stdout.split("\0").filter((p) => p !== "");
  } catch {
    return undefined;
  }
}

async function walkFiles(opts: ListOptions): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [""];
  // Stop well past the limit so `dropped` still says roughly how many there were.
  const cap = opts.limit * 4;
  for (let rel = queue.shift(); rel !== undefined && out.length < cap; rel = queue.shift()) {
    const entries = await readdir(join(opts.dir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) queue.push(path);
      else if (entry.isFile() && !isIgnoredPath(path)) out.push(path);
    }
  }
  return out;
}

/**
 * List the source files the map should read.
 *
 * @param opts - Directory, git ceiling and file limit.
 * @returns Paths sorted, with ignored files removed and at most `limit` kept.
 */
export async function listSourceFiles(opts: ListOptions): Promise<ListResult> {
  const fromGit = await gitFiles(opts);
  const source = fromGit ? "git" : "walk";
  const all = (fromGit ?? (await walkFiles(opts))).filter((p) => !isIgnoredPath(p)).sort();
  return { files: all.slice(0, opts.limit), dropped: Math.max(0, all.length - opts.limit), source };
}
