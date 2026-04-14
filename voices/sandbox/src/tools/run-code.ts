import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import { execute } from "../executor.js";
import type { ExecOptions } from "../executor.js";

const parameters = z.object({
  code: z.string().min(1).describe("Source code to execute"),
  language: z
    .enum(["typescript", "python", "bash"])
    .describe("Execution runtime: typescript, python, or bash"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe("Wall-clock timeout in ms (default 30 000, max 120 000)"),
});

type RunCodeInput = z.infer<typeof parameters>;

/**
 * Create the `run_code` tool.
 *
 * @param defaults - Default {@link ExecOptions} applied to every call.
 *                   Per-call `timeout_ms` from the agent overrides the
 *                   default.
 */
export function createRunCodeTool(
  defaults: ExecOptions = {},
): Tool<RunCodeInput> {
  return {
    name: "run_code",
    description:
      "Execute a code snippet and return its stdout, stderr, and exit code. " +
      "Supports TypeScript (via tsx), Python 3, and Bash.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const result = await execute(input.code, input.language, {
          ...defaults,
          timeout_ms: input.timeout_ms ?? defaults.timeout_ms,
        });

        const parts: string[] = [];

        if (result.stdout) {
          parts.push("stdout:\n" + result.stdout);
        }
        if (result.stderr) {
          parts.push("stderr:\n" + result.stderr);
        }
        if (parts.length === 0) {
          parts.push("(no output)");
        }

        parts.push("exit_code: " + result.exit_code);
        parts.push("duration_ms: " + result.duration_ms);
        if (result.truncated) {
          parts.push("(output was truncated to 10 KB)");
        }

        const isError = result.exit_code !== 0;

        return {
          content: parts.join("\n\n"),
          is_error: isError || undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: "Execution failed: " + message,
          is_error: true,
        };
      }
    },
  };
}
