/**
 * Core code execution engine.
 *
 * Spawns a child process per language, enforces a wall-clock timeout,
 * and sanitises the output.
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { stripAnsi, truncateOutput, redactPaths } from "./utils/sanitize.js";

/**
 * Resolve the tsx binary path. Prefers the locally-installed version
 * (fast) over npx (slow cold-start in CI).
 */
let tsxBin: string | undefined;
function resolveTsx(): [string, string[]] {
  if (tsxBin === undefined) {
    try {
      tsxBin = execFileSync("which", ["tsx"], { encoding: "utf-8" }).trim();
    } catch {
      try {
        // npm/pnpm puts binaries in node_modules/.bin which is on PATH
        // when running via npm scripts, but not in raw shells.
        tsxBin = execFileSync("npx", ["which", "tsx"], { encoding: "utf-8" }).trim();
      } catch {
        tsxBin = "";
      }
    }
  }
  if (tsxBin) return [tsxBin, ["--no-cache"]];
  return ["npx", ["tsx", "--no-cache"]];
}

/** Supported execution languages. */
export type Language = "typescript" | "python" | "bash";

/** Options for {@link execute}. */
export interface ExecOptions {
  /** Wall-clock timeout in ms. Default: 30 000 (30 s). */
  timeout_ms?: number;
  /** Extra environment variables merged with the child process env. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  working_dir?: string;
}

/** Result of a code execution. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  /** `true` if stdout or stderr was truncated to 10 KB. */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build the spawn command and arguments for a given language.
 *
 * For TypeScript and Python the code is written to a temp file so
 * that multi-line scripts, imports, and shebangs work reliably.
 *
 * @returns `[command, args, tempFile?]` — caller must clean up the
 *          temp file when provided.
 */
async function buildCommand(
  code: string,
  language: Language,
): Promise<[string, string[], string | undefined]> {
  switch (language) {
    case "typescript": {
      const dir = await mkdtemp(join(tmpdir(), "tutti-ts-"));
      // Use .mts so tsx treats the file as ESM (enables top-level await).
      const file = join(dir, randomUUID() + ".mts");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from mkdtemp + randomUUID
      await writeFile(file, code, "utf-8");
      const [bin, args] = resolveTsx();
      return [bin, [...args, file], file];
    }
    case "python": {
      const dir = await mkdtemp(join(tmpdir(), "tutti-py-"));
      const file = join(dir, randomUUID() + ".py");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from mkdtemp + randomUUID
      await writeFile(file, code, "utf-8");
      return ["python3", [file], file];
    }
    case "bash":
      return ["/bin/bash", ["-c", code], undefined];
  }
}

/**
 * Execute a code snippet in a sandboxed child process.
 *
 * @param code     - Source code to execute.
 * @param language - Target runtime.
 * @param options  - Timeout, env overrides, and working directory.
 * @returns A structured result with stdout, stderr, exit code, and
 *          timing information.
 */
export async function execute(
  code: string,
  language: Language,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const [cmd, args, tempFile] = await buildCommand(code, language);

  const cwd = options.working_dir ?? tmpdir();

  const start = Date.now();

  return new Promise<ExecResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      timeout: 0, // we handle timeout ourselves
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      killed = true;
      // Kill the process. On POSIX this sends SIGKILL; on Windows it
      // uses TerminateProcess.
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);

      const rawStdout = stripAnsi(Buffer.concat(stdoutChunks).toString("utf-8"));
      const rawStderr = stripAnsi(Buffer.concat(stderrChunks).toString("utf-8"));

      const [stdout, stdoutTrunc] = truncateOutput(rawStdout);
      const [stderr, stderrTrunc] = truncateOutput(rawStderr);

      const safeStdout = redactPaths(stdout, cwd);
      const safeStderr = redactPaths(stderr, cwd);

      // Clean up temp file asynchronously — don't block the result.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempFile from mkdtemp + randomUUID
      if (tempFile) void unlink(tempFile).catch(() => {});

      resolve({
        stdout: safeStdout,
        stderr: killed
          ? safeStderr + (safeStderr ? "\n" : "") + `Process killed after ${timeoutMs}ms timeout`
          : safeStderr,
        exit_code: killed ? 137 : (exitCode ?? 1),
        duration_ms: Date.now() - start,
        truncated: stdoutTrunc || stderrTrunc,
      });
    });

    // Handle spawn failures (e.g. command not found).
    child.on("error", (err) => {
      clearTimeout(timer);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempFile from mkdtemp + randomUUID
      if (tempFile) void unlink(tempFile).catch(() => {});

      resolve({
        stdout: "",
        stderr: err.message,
        exit_code: 127,
        duration_ms: Date.now() - start,
        truncated: false,
      });
    });
  });
}
