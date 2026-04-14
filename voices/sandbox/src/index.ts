import type { Permission, Tool, Voice } from "@tuttiai/types";
import { createRunCodeTool } from "./tools/run-code.js";
import type { ExecOptions } from "./executor.js";

export type { ExecOptions, ExecResult, Language } from "./executor.js";
export { execute } from "./executor.js";
export { createRunCodeTool } from "./tools/run-code.js";
export { stripAnsi, truncateOutput, redactPaths } from "./utils/sanitize.js";

/**
 * Options for {@link SandboxVoice}.
 */
export interface SandboxVoiceOptions {
  /** Default timeout for all executions. Default: 30 000 ms. */
  timeout_ms?: number;
  /** Working directory for child processes. Default: OS temp dir. */
  working_dir?: string;
  /** Extra env vars merged into the child process environment. */
  env?: Record<string, string>;
}

/**
 * Sandbox voice — gives agents secure code execution.
 *
 * Supports TypeScript (via `tsx`), Python 3, and Bash.
 *
 * @example
 * ```ts
 * import { SandboxVoice } from "@tuttiai/sandbox";
 *
 * const score = defineScore({
 *   agents: {
 *     coder: {
 *       voices: [new SandboxVoice()],
 *       permissions: ["shell"],
 *     },
 *   },
 * });
 * ```
 */
export class SandboxVoice implements Voice {
  readonly name = "sandbox";
  readonly description = "Execute code in TypeScript, Python, or Bash";
  readonly required_permissions: Permission[] = ["shell"];
  readonly tools: Tool[];

  constructor(options: SandboxVoiceOptions = {}) {
    const defaults: ExecOptions = {
      timeout_ms: options.timeout_ms,
      working_dir: options.working_dir,
      env: options.env,
    };
    this.tools = [createRunCodeTool(defaults)];
  }
}
