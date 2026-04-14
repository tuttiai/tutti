import type { Permission, Tool, Voice, VoiceContext } from "@tuttiai/types";
import { createRunCodeTool } from "./tools/run-code.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createInstallPackageTool } from "./tools/install-package.js";
import type { InstallPackageOptions } from "./tools/install-package.js";
import type { ExecOptions } from "./executor.js";
import { SessionSandbox } from "./sandbox.js";

export type { ExecOptions, ExecResult, Language } from "./executor.js";
export { execute } from "./executor.js";
export { SessionSandbox, SandboxEscapeError } from "./sandbox.js";
export { createRunCodeTool } from "./tools/run-code.js";
export { createReadFileTool } from "./tools/read-file.js";
export { createWriteFileTool } from "./tools/write-file.js";
export { createInstallPackageTool } from "./tools/install-package.js";
export type { InstallPackageOptions } from "./tools/install-package.js";
export { stripAnsi, truncateOutput, redactPaths } from "./utils/sanitize.js";

/**
 * Options for {@link SandboxVoice}.
 */
export interface SandboxVoiceOptions {
  /** Default timeout for code executions. Default: 30 000 ms. */
  timeout_ms?: number;
  /** Extra env vars merged into child process environments. */
  env?: Record<string, string>;
  /**
   * Package allowlist for `install_package`. When set, only packages
   * in this list can be installed. When omitted all packages are
   * allowed.
   */
  allowedPackages?: string[];
  /** Timeout for package installs. Default: 60 000 ms. */
  install_timeout_ms?: number;
}

/**
 * Sandbox voice — gives agents secure code execution with per-session
 * filesystem isolation.
 *
 * On {@link setup}, creates `/tmp/tutti-sandbox/{session_id}/`. All
 * file tools and `run_code` are confined to this directory. On
 * {@link teardown}, the directory is deleted.
 *
 * @example
 * ```ts
 * import { SandboxVoice } from "@tuttiai/sandbox";
 *
 * const score = defineScore({
 *   agents: {
 *     coder: {
 *       voices: [new SandboxVoice({ allowedPackages: ["lodash"] })],
 *       permissions: ["shell"],
 *     },
 *   },
 * });
 * ```
 */
export class SandboxVoice implements Voice {
  readonly name = "sandbox";
  readonly description =
    "Execute code, read/write files, and install packages in an isolated sandbox";
  readonly required_permissions: Permission[] = ["shell"];
  tools: Tool[] = [];

  private sandbox: SessionSandbox | undefined;
  private readonly options: SandboxVoiceOptions;

  constructor(options: SandboxVoiceOptions = {}) {
    this.options = options;
  }

  /**
   * Called once per runtime — creates the session sandbox directory and
   * builds the tool array.
   */
  async setup(context: VoiceContext): Promise<void> {
    this.sandbox = new SessionSandbox(context.session_id);
    await this.sandbox.init();

    const defaults: ExecOptions = {
      timeout_ms: this.options.timeout_ms,
      env: this.options.env,
    };

    const installOpts: InstallPackageOptions = {
      allowedPackages: this.options.allowedPackages,
      timeout_ms: this.options.install_timeout_ms,
    };

    this.tools = [
      createRunCodeTool(defaults, this.sandbox),
      createReadFileTool(this.sandbox),
      createWriteFileTool(this.sandbox),
      createInstallPackageTool(this.sandbox, installOpts),
    ];
  }

  /** Remove the per-session sandbox directory. */
  async teardown(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.destroy();
      this.sandbox = undefined;
    }
  }
}
