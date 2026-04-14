import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import type { SessionSandbox } from "../sandbox.js";

const parameters = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path relative to the sandbox root"),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("File encoding (default utf-8)"),
});

type ReadFileInput = z.infer<typeof parameters>;

/**
 * Create the `sandbox_read_file` tool.
 *
 * @param sandbox - The session sandbox that enforces path confinement.
 */
export function createReadFileTool(
  sandbox: SessionSandbox,
): Tool<ReadFileInput> {
  return {
    name: "read_file",
    description:
      "Read a file from the sandbox directory. " +
      "The path must be relative to (or inside) the sandbox root.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const resolved = sandbox.resolve(input.path);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path resolved via sandbox.resolve() which enforces confinement
        const content = await readFile(resolved, input.encoding);
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, is_error: true };
      }
    },
  };
}
