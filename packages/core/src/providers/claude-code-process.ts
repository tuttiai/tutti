import { spawn } from "node:child_process";

/** What one `claude -p` invocation produced. */
export interface ClaudeCodeRunResult {
  /** Process exit code, or `null` when it was killed by a signal. */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never started, e.g. `ENOENT` for a missing binary. */
  spawn_error?: NodeJS.ErrnoException;
  /** True when the run was killed for exceeding its timeout. */
  timed_out: boolean;
  /** True when the invocation's signal stopped the run, or aborted before it started. */
  aborted?: boolean;
}

/** One invocation of the Claude Code CLI. */
export interface ClaudeCodeInvocation {
  command: string;
  args: string[];
  /** Written to the process's stdin, which is then closed. */
  stdin: string;
  timeout_ms: number;
  cwd: string;
  /** Kills the process when aborted. One already aborted means it is never started. */
  signal?: AbortSignal;
}

/**
 * Runs the Claude Code CLI once. Injectable so tests never start a process.
 */
export type ClaudeCodeRunner = (
  invocation: ClaudeCodeInvocation,
) => Promise<ClaudeCodeRunResult>;

/**
 * Default {@link ClaudeCodeRunner}: spawns the CLI without a shell, feeds the
 * prompt on stdin and collects both streams. The prompt goes on stdin rather
 * than argv because a conversation can outgrow the per-argument limit.
 *
 * An aborted `signal` kills the process, so a run whose caller has gone away
 * stops spending the account's usage on a reply nobody will read.
 *
 * @param invocation - Command, arguments, stdin, limits and signal for the run.
 * @returns The exit code and captured output. Never rejects.
 */
export function runClaudeCode(
  invocation: ClaudeCodeInvocation,
): Promise<ClaudeCodeRunResult> {
  const { signal } = invocation;
  if (signal?.aborted) {
    return Promise.resolve({ exit_code: null, stdout: "", stderr: "", timed_out: false, aborted: true });
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timed_out = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timed_out = true;
      child.kill("SIGKILL");
    }, invocation.timeout_ms);
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (extra: Partial<ClaudeCodeRunResult>): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exit_code: null, stdout: text(out), stderr: text(err), timed_out, ...(aborted && { aborted }), ...extra });
    };
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => finish({ spawn_error: error }));
    child.on("close", (code) => finish({ exit_code: code }));
    // A child that exits before reading stdin raises EPIPE here; "close" reports it.
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin);
  });
}

function text(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}
