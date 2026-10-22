import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";

import { buildRepoMap, DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP } from "../repo-map/repo-map.js";
import type { SessionSandbox } from "../sandbox.js";
import { redactPaths } from "../utils/sanitize.js";

const parameters = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe("Directory to map, relative to the sandbox root (default: the sandbox root)"),
  focus: z
    .array(z.string().min(1).max(300))
    .max(50)
    .optional()
    .describe(
      "File paths (relative to path) and/or identifiers your task is about. " +
        "The map is centred on them and on what they use.",
    ),
  max_tokens: z
    .number()
    .int()
    .min(200)
    .max(MAX_TOKENS_CAP)
    .optional()
    .describe(`Size of the map in tokens (default ${DEFAULT_MAX_TOKENS}, max ${MAX_TOKENS_CAP})`),
});

type RepoMapInput = z.infer<typeof parameters>;

/** Directory inside the sandbox where the tag cache is kept. */
export const REPO_MAP_CACHE_DIR = join(".tutti-cache", "repo-map");

/** Whether `dir`, with symbolic links followed, is still inside `root`. */
async function staysInside(dir: string, root: string): Promise<boolean> {
  const [real, realRoot] = await Promise.all([realpath(dir), realpath(root)]);
  return real === realRoot || real.startsWith(realRoot + "/");
}

/**
 * Create the `repo_map` tool.
 *
 * @param sandbox - The session sandbox: the directory to map must be in it,
 *                  and the tag cache is kept in it.
 */
export function createRepoMapTool(sandbox: SessionSandbox): Tool<RepoMapInput> {
  return {
    name: "repo_map",
    description:
      "Call this first when working in a repository, before reading files. Returns a " +
      "ranked map of the repository: the files that matter most and, under each, the " +
      "one-line signatures of its key functions, classes, types and methods with their " +
      "line numbers, within a token budget. Pass focus with the files or names your task " +
      "is about to centre the map on them. Then read only the line ranges you need with " +
      "read_file's start_line and end_line instead of whole files.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const dir = sandbox.resolve(input.path ?? ".");
        const st = await stat(dir).catch(() => undefined);
        if (!st?.isDirectory() || !(await staysInside(dir, sandbox.root))) {
          return {
            content: `Not a directory: ${input.path ?? "."}. Pass path as a directory relative to the sandbox root, such as the folder a repository was cloned into.`,
            is_error: true,
          };
        }
        const result = await buildRepoMap({
          dir,
          ceiling: sandbox.root,
          cache_dir: sandbox.resolve(REPO_MAP_CACHE_DIR),
          ...(input.focus ? { focus: input.focus } : {}),
          ...(input.max_tokens ? { max_tokens: input.max_tokens } : {}),
        });
        return { content: result.text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: "repo_map failed: " + redactPaths(message, sandbox.root),
          is_error: true,
        };
      }
    },
  };
}
