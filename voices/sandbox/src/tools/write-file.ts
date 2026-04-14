import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import type { SessionSandbox } from "../sandbox.js";

const parameters = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path relative to the sandbox root"),
  content: z.string().describe("Content to write"),
});

type WriteFileInput = z.infer<typeof parameters>;

/**
 * Create the `sandbox_write_file` tool.
 *
 * @param sandbox - The session sandbox that enforces path confinement.
 */
export function createWriteFileTool(
  sandbox: SessionSandbox,
): Tool<WriteFileInput> {
  return {
    name: "sandbox_write_file",
    description:
      "Write a file to the sandbox directory. " +
      "Creates parent directories as needed. " +
      "The path must be relative to (or inside) the sandbox root.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const resolved = sandbox.resolve(input.path);
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, input.content, "utf-8");
        return { content: "Wrote " + input.path };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, is_error: true };
      }
    },
  };
}
