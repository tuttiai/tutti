import { access, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { TypeScript } from "./samples/compile.js";
import type { SamplesFs } from "./samples/discover.js";
import { EXIT_INCOMPLETE } from "./samples/report.js";
import type { Writer } from "./samples/report.js";
import { run } from "./samples/run.js";

/**
 * `npm run docs:check-samples`: type-checks every ts/tsx code block in docs/**\/*.mdx against the
 * built workspace packages, with docs/code-samples.skip.json listing the samples that fail today.
 * Build first (`npm run build`): samples import the packages' built declarations, and without
 * them the run stops with exit code 2. See docs/scripts/samples/run.ts.
 *
 * It runs under tsx from docs/scripts/, so the repository root is two levels up from this file:
 * not the working directory and not the environment.
 */

const root = resolve(import.meta.dirname, "../..");

// The root's own TypeScript (pinned in the root package.json), never a copy under docs/node_modules,
// which the docs site's install may bring in. require() is untyped; the annotation names the module.
const ts: TypeScript = createRequire(join(root, "package.json"))("typescript");

const fs: SamplesFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
  exists: (path) => access(path).then(
    () => true,
    () => false,
  ),
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
  process.exitCode = await run({ root, fs, write, ts });
} catch (error: unknown) {
  write.err(`docs:check-samples: ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = EXIT_INCOMPLETE;
}
