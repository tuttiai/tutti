import { z } from "zod";
import type { Tool, ToolResult } from "@tuttiai/types";
import { execute } from "../executor.js";
import type { SessionSandbox } from "../sandbox.js";

/** Regex: a package name must be printable and not contain shell meta-characters. */
const SAFE_NAME_RE = /^[a-zA-Z0-9@_./-]+$/;

const parameters = z.object({
  name: z
    .string()
    .min(1)
    .describe("Package name to install (e.g. 'lodash', 'numpy')"),
  manager: z
    .enum(["npm", "pip"])
    .default("npm")
    .describe("Package manager to use (default npm)"),
});

type InstallInput = z.infer<typeof parameters>;

/** Options for the install_package tool. */
export interface InstallPackageOptions {
  /**
   * Allowlist of permitted package names. When set, any name not in
   * the list is rejected before the install command runs.
   * When `undefined`, all packages are allowed.
   */
  allowedPackages?: string[];
  /** Install timeout in ms. Default: 60 000 (60 s). */
  timeout_ms?: number;
}

/**
 * Create the `install_package` tool.
 *
 * @param sandbox - Session sandbox whose root becomes the install prefix.
 * @param opts    - Allowlist and timeout configuration.
 */
export function createInstallPackageTool(
  sandbox: SessionSandbox,
  opts: InstallPackageOptions = {},
): Tool<InstallInput> {
  const allowed = opts.allowedPackages
    ? new Set(opts.allowedPackages)
    : undefined;

  const timeoutMs = opts.timeout_ms ?? 60_000;

  return {
    name: "install_package",
    description:
      "Install a package into the sandbox. " +
      "Uses npm or pip. Installed into the sandbox directory only.",
    parameters,
    execute: async (input): Promise<ToolResult> => {
      try {
        // Validate the package name doesn't contain shell injection chars.
        if (!SAFE_NAME_RE.test(input.name)) {
          return {
            content:
              "Invalid package name: must contain only alphanumeric " +
              "characters, @, _, ., /, and -.",
            is_error: true,
          };
        }

        // Allowlist check.
        if (allowed && !allowed.has(input.name)) {
          return {
            content:
              `Package "${input.name}" is not in the allowed list. ` +
              "Permitted packages: " + [...allowed].join(", "),
            is_error: true,
          };
        }

        const cmd =
          input.manager === "pip"
            ? `pip install --target "${sandbox.root}" ${input.name}`
            : `npm install --prefix "${sandbox.root}" ${input.name}`;

        const start = Date.now();
        const result = await execute(cmd, "bash", {
          timeout_ms: timeoutMs,
          working_dir: sandbox.root,
        });

        if (result.exit_code !== 0) {
          return {
            content:
              `Failed to install ${input.name} via ${input.manager}:\n` +
              result.stderr,
            is_error: true,
          };
        }

        // Try to extract the installed version from stdout.
        const version = extractVersion(result.stdout, input.name) ?? "unknown";

        return {
          content: JSON.stringify({
            package: input.name,
            version,
            duration_ms: Date.now() - start,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: "Install failed: " + message, is_error: true };
      }
    },
  };
}

/**
 * Best-effort version extraction from npm/pip install output.
 */
function extractVersion(stdout: string, name: string): string | undefined {
  // npm: "added 1 package" or "+ lodash@4.17.21"
  const npmMatch = new RegExp("\\+\\s*" + escapeRegExp(name) + "@([^\\s]+)").exec(stdout);
  if (npmMatch?.[1]) return npmMatch[1];

  // pip: "Successfully installed numpy-1.24.0"
  const pipMatch = new RegExp("Successfully installed.*?" + escapeRegExp(name) + "-([^\\s,]+)").exec(stdout);
  if (pipMatch?.[1]) return pipMatch[1];

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
