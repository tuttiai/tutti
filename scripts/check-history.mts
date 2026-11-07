import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { GitResult, GitRunner } from "./integrity/git.js";
import { runHistory } from "./integrity/history-run.js";
import { EXIT_INCOMPLETE } from "./integrity/run.js";
import type { Writer } from "./integrity/run.js";

/**
 * `npm run check:history`: reads the history of main, without fetching or writing anything, and
 * fails on a merge commit that added config-file content found in neither parent, or on a
 * merged pull request whose head is not on main. See scripts/integrity/history-merges.ts and
 * history-pulls.ts.
 *
 * It runs under tsx from scripts/, so the repository root is one level up from this file. Git is run with an argument array and no shell; its stderr is dropped.
 */

const root = resolve(import.meta.dirname, "..");

// The environment is only handed on to git, which needs PATH and HOME; no value is read here.
// GIT_PAGER and GIT_TERMINAL_PROMPT keep git from waiting on a person; LC_ALL fixes its output.
const env = { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

const git: GitRunner = {
  run: (args) =>
    new Promise<GitResult>((done, fail) => {
      const options = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env } as const;
      execFile("git", [...args], options, (error, stdout) => {
        if (error === null) done({ code: 0, stdout });
        else if (typeof error.code === "number") done({ code: error.code, stdout });
        else fail(error instanceof Error ? error : new Error("git could not be run"));
      });
    }),
};

const write: Writer = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

try {
  process.exitCode = await runHistory({ git, argv: process.argv.slice(2), write });
} catch (error: unknown) {
  // The error's code only, such as ENOENT when git is not installed: never its message or output.
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed";
  write.err(`check:history: git could not be run (${code})`);
  process.exitCode = EXIT_INCOMPLETE;
}
