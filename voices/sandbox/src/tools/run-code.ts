import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import { execute } from "../executor.js";
import type { ExecOptions, Language } from "../executor.js";
import type { SessionSandbox } from "../sandbox.js";

/** Options for {@link createExecuteCodeTool}. */
export interface ExecuteCodeOptions {
  /** Default exec options (timeout, env). */
  defaults?: ExecOptions;
  /** Session sandbox — its root becomes the working_dir. */
  sandbox?: SessionSandbox;
  /** Restrict which languages the agent can use. */
  allowed_languages?: Language[];
}

const ALL_LANGUAGES: [Language, ...Language[]] = ["typescript", "python", "bash"];

/**
 * Build the Zod parameters schema. When `allowed_languages` is set,
 * the `language` enum is narrowed so the agent cannot select a
 * disallowed runtime.
 */
function buildParameters(allowed: Language[] | undefined): z.ZodObject<{
  code: z.ZodString;
  language: z.ZodEnum<[string, ...string[]]>;
  timeout_ms: z.ZodOptional<z.ZodNumber>;
}> {
  const langs: [string, ...string[]] =
    allowed && allowed.length > 0
      ? (allowed as [string, ...string[]])
      : ALL_LANGUAGES;

  return z.object({
    code: z.string().min(1).describe("Source code to execute"),
    language: z
      .enum(langs)
      .describe("Execution runtime: " + langs.join(", ")),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe("Wall-clock timeout in ms (default 30 000, max 120 000)"),
  });
}

/**
 * Create the `execute_code` tool.
 *
 * @param opts - Execution defaults, sandbox, and language restrictions.
 */
export function createExecuteCodeTool(
  opts: ExecuteCodeOptions = {},
): Tool<z.infer<ReturnType<typeof buildParameters>>> {
  const defaults = opts.defaults ?? {};
  const sandbox = opts.sandbox;
  const parameters = buildParameters(opts.allowed_languages);

  return {
    name: "execute_code",
    description:
      "Execute a code snippet and return its stdout, stderr, and exit code. " +
      "Supports TypeScript (via tsx), Python 3, and Bash. " +
      "The working directory is the sandbox root.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        const lang = input.language as Language;
        const result = await execute(input.code, lang, {
          ...defaults,
          working_dir: sandbox?.root ?? defaults.working_dir,
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

        return {
          content: parts.join("\n\n"),
          is_error: result.exit_code !== 0 || undefined,
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
