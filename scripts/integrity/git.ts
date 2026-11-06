/** What one git call returned. Its stderr is never kept, so nothing git prints can be echoed. */
export interface GitResult {
  /** The exit code. A non-zero code is returned here, never thrown. */
  readonly code: number;
  /** Standard output, decoded as UTF-8. */
  readonly stdout: string;
}

/** Runs git with an argument list, never through a shell. Injected so tests run no git. */
export interface GitRunner {
  /** Runs `git <args>` in the repository root. Rejects only when git could not be run at all. */
  readonly run: (args: readonly string[]) => Promise<GitResult>;
}

/** A git call that exited non-zero. It carries the subcommand and the exit code, nothing git printed. */
export class GitError extends Error {
  /**
   * @param subcommand - The git subcommand that failed, such as `rev-list`.
   * @param code - Its exit code.
   */
  constructor(
    readonly subcommand: string,
    readonly code: number,
  ) {
    super(`git ${subcommand} exited ${String(code)}`);
    this.name = "GitError";
  }
}

/**
 * Options every diff call carries, so neither the repository's config nor its `.gitattributes`
 * can make git run an external diff driver or a textconv filter, and no colour code reaches the parser.
 */
export const SAFE_DIFF: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color"];

/**
 * Runs git and returns its stdout, or throws {@link GitError} on a non-zero exit.
 *
 * @param git - The runner.
 * @param args - The arguments, the subcommand first.
 * @returns Standard output.
 */
export async function gitOk(git: GitRunner, args: readonly string[]): Promise<string> {
  const result = await git.run(args);
  if (result.code !== 0) throw new GitError(args[0] ?? "", result.code);
  return result.stdout;
}

/**
 * Whether the clone is shallow, in which case its history is cut off and cannot be checked.
 *
 * @param git - The runner.
 * @returns True for a shallow clone.
 */
export async function isShallow(git: GitRunner): Promise<boolean> {
  return (await gitOk(git, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
}

/**
 * Resolves a ref to the commit it names. The ref goes after `--end-of-options`, so it is never
 * read as an option.
 *
 * @param git - The runner.
 * @param ref - A ref already checked by `isSafeRef`.
 * @returns The full commit SHA, or null when the ref names no commit.
 */
export async function resolveCommit(git: GitRunner, ref: string): Promise<string | null> {
  const result = await git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}
