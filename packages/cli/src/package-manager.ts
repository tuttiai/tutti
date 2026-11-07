/**
 * Runs npm, yarn or pnpm with an argument array and never through a shell
 * on POSIX, so no argument can be read as shell syntax.
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";

/** A package manager the CLI can drive. */
export type PackageManager = "npm" | "yarn" | "pnpm";

/** Options for {@link runPackageManager}. */
export interface RunPackageManagerOptions {
  /** Working directory; defaults to `process.cwd()`. */
  cwd?: string;
  /** Capture stdout instead of showing the package manager's output. */
  capture?: boolean;
}

/** Outcome of {@link runPackageManager}; it never throws. */
export type PackageManagerResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; error: string };

/**
 * Wrap an argument in double quotes for cmd.exe. Only safe because every
 * argument has passed `parsePackageSpec` first, which allows no `"`, `%`,
 * `!`, `&`, `|`, `<` or `>`. The quotes also keep a `^` literal.
 */
function quoteForCmd(arg: string): string {
  return `"${arg}"`;
}

function spawn(cmd: PackageManager, args: readonly string[], opts: RunPackageManagerOptions): SpawnSyncReturns<string> {
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf-8",
    stdio: opts.capture === true ? "pipe" : "inherit",
    windowsHide: true,
  };
  if (process.platform === "win32") {
    // Since the CVE-2024-27980 fix Node refuses to spawn a .cmd file
    // without a shell (EINVAL), and npm, yarn and pnpm are .cmd shims on
    // Windows. The line is built here rather than passed as arguments with
    // shell: true, which Node 24 deprecates (DEP0190).
    const line = [`${cmd}.cmd`, ...args.map(quoteForCmd)].join(" ");
    return spawnSync(line, { ...options, shell: true });
  }
  return spawnSync(cmd, [...args], { ...options, shell: false });
}

function describeSpawnError(cmd: PackageManager, error: Error): string {
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return `Could not run ${cmd}. Is Node.js/${cmd} installed and on your PATH?`;
  }
  return `Could not run ${cmd}: ${error.message}`;
}

/**
 * Run a package manager command without a shell (see the Windows note in
 * the source for the one exception).
 *
 * @param cmd - `npm`, `yarn` or `pnpm`.
 * @param args - Arguments, each already validated with `parsePackageSpec`.
 * @param opts - Working directory, and whether to capture stdout.
 * @returns `{ ok: true, stdout }`, or `{ ok: false, status, error }` with a
 *   message for the user when the command could not start or exited non-zero.
 */
export function runPackageManager(
  cmd: PackageManager,
  args: readonly string[],
  opts: RunPackageManagerOptions = {},
): PackageManagerResult {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawn(cmd, args, opts);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, status: null, error: describeSpawnError(cmd, err) };
  }
  if (result.error) {
    return { ok: false, status: null, error: describeSpawnError(cmd, result.error) };
  }
  if (result.status !== 0) {
    const exit = result.status === null ? `signal ${String(result.signal)}` : `exit code ${result.status}`;
    return { ok: false, status: result.status, error: `${[cmd, ...args].join(" ")} failed (${exit}).` };
  }
  return { ok: true, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}
