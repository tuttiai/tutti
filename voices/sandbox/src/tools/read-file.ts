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
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("First line to return, 1-based (utf-8 only). Use the line numbers repo_map gives."),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Last line to return, inclusive (utf-8 only; default the end of the file)"),
});

type ReadFileInput = z.infer<typeof parameters>;

/**
 * Cut a file's text to a 1-based, inclusive line range, opening with a
 * line that says which lines of how many were returned.
 *
 * @param content - The whole file.
 * @param start - First line wanted (default 1).
 * @param end - Last line wanted (default the last line).
 * @returns The header line and the chosen lines.
 */
export function sliceLines(content: string, start = 1, end?: number): string {
  const lines = content.split("\n");
  const total = lines.length;
  const last = Math.min(end ?? total, total);
  if (start > total) return `[line ${start} is past the end: the file has ${total} lines]`;
  return `[lines ${start}-${last} of ${total}]\n` + lines.slice(start - 1, last).join("\n");
}

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
      "The path must be relative to (or inside) the sandbox root. " +
      "Pass start_line and end_line to read only part of a file, such as a " +
      "definition repo_map pointed to.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const ranged = input.start_line !== undefined || input.end_line !== undefined;
        if (ranged && input.encoding === "base64") {
          return { content: "start_line and end_line need utf-8 encoding. Drop encoding or the line range.", is_error: true };
        }
        if (ranged && (input.end_line ?? Infinity) < (input.start_line ?? 1)) {
          return { content: "end_line is before start_line. Pass end_line at or after start_line.", is_error: true };
        }
        const resolved = sandbox.resolve(input.path);
        const content = await readFile(resolved, input.encoding);
        return { content: ranged ? sliceLines(content, input.start_line, input.end_line) : content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, is_error: true };
      }
    },
  };
}
