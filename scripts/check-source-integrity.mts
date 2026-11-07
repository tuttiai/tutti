import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IntegrityFs } from "./integrity/discover.js";
import { EXIT_INCOMPLETE, run } from "./integrity/run.js";
import type { Writer } from "./integrity/run.js";

/**
 * `npm run check:integrity`: reads every config file a toolchain would load, without loading
 * any, and fails on code a config file has no reason to contain. See scripts/integrity/rules.ts.
 *
 * It runs under tsx from scripts/, so the repository root is one level up from this
 * file: not the working directory and not the environment. Output follows the
 * repository's other CLIs: plain lines on stdout and stderr, and an error's message, never the
 * error object.
 */

const root = resolve(import.meta.dirname, "..");

const fs: IntegrityFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
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
  process.exitCode = await run({ root, fs, write });
} catch (error: unknown) {
  write.err(`check:integrity: ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = EXIT_INCOMPLETE;
}
