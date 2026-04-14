import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import type { SessionSandbox } from "../sandbox.js";

/** Default max file size: 1 MB. */
const DEFAULT_MAX_BYTES = 1_048_576;

const parameters = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path relative to the sandbox root"),
  content: z.string().describe("Content to write"),
});

type WriteFileInput = z.infer<typeof parameters>;

/**
 * Create the `write_file` tool.
 *
 * @param sandbox       - Session sandbox that enforces path confinement.
 * @param maxFileBytes  - Maximum allowed file size in bytes. Default: 1 MB.
 */
export function createWriteFileTool(
  sandbox: SessionSandbox,
  maxFileBytes: number = DEFAULT_MAX_BYTES,
): Tool<WriteFileInput> {
  return {
    name: "write_file",
    description:
      "Write a file to the sandbox directory. " +
      "Creates parent directories as needed. " +
      "The path must be relative to (or inside) the sandbox root.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const bytes = Buffer.byteLength(input.content, "utf-8");
        if (bytes > maxFileBytes) {
          return {
            content:
              `File too large: ${bytes} bytes exceeds the ` +
              `${maxFileBytes} byte limit. Write less content or split ` +
              "across multiple files.",
            is_error: true,
          };
        }

        const resolved = sandbox.resolve(input.path);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path resolved via sandbox.resolve() which enforces confinement
        await mkdir(dirname(resolved), { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path resolved via sandbox.resolve() which enforces confinement
        await writeFile(resolved, input.content, "utf-8");
        return { content: "Wrote " + input.path + " (" + bytes + " bytes)" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, is_error: true };
      }
    },
  };
}
