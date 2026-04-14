import type { Permission, Tool, Voice, VoiceContext } from "@tuttiai/types";
import { createExecuteCodeTool } from "./tools/run-code.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createInstallPackageTool } from "./tools/install-package.js";
import type { Language } from "./executor.js";
import { SessionSandbox } from "./sandbox.js";

export type { ExecOptions, ExecResult, Language } from "./executor.js";
export { execute } from "./executor.js";
export { SessionSandbox, SandboxEscapeError } from "./sandbox.js";
export { createExecuteCodeTool } from "./tools/run-code.js";
export type { ExecuteCodeOptions } from "./tools/run-code.js";
export { createReadFileTool } from "./tools/read-file.js";
export { createWriteFileTool } from "./tools/write-file.js";
export { createInstallPackageTool } from "./tools/install-package.js";
export type { InstallPackageOptions } from "./tools/install-package.js";
export { stripAnsi, truncateOutput, redactPaths } from "./utils/sanitize.js";

/**
 * Configuration for {@link SandboxVoice}.
 */
export interface SandboxConfig {
  /**
   * Restrict which languages the agent can execute. When omitted all
   * three are available (`typescript`, `python`, `bash`).
   */
  allowed_languages?: Language[];
  /**
   * Package allowlist for `install_package`. When set, only packages
   * in this list can be installed. When omitted all packages are
   * allowed.
   */
  allowed_packages?: string[];
  /** Default wall-clock timeout for code executions. Default: 30 000 ms. */
  timeout_ms?: number;
  /**
   * Maximum file size (in bytes) that `write_file` will accept.
   * Default: 1 048 576 (1 MB).
   */
  max_file_size_bytes?: number;
  /** Extra env vars merged into child process environments. */
  env?: Record<string, string>;
  /** Timeout for package installs. Default: 60 000 ms. */
  install_timeout_ms?: number;
}

/**
 * Sandbox voice — gives agents secure code execution with per-session
 * filesystem isolation.
 *
 * On {@link setup}, creates `/tmp/tutti-sandbox/{session_id}/`. All
 * tools are confined to this directory. On {@link teardown}, the
 * directory is deleted.
 *
 * Tools: `execute_code`, `read_file`, `write_file`, `install_package`.
 *
 * Required permission: `"shell"`.
 *
 * @example
 * ```ts
 * import { SandboxVoice } from "@tuttiai/sandbox";
 *
 * const score = defineScore({
 *   agents: {
 *     coder: {
 *       voices: [new SandboxVoice({
 *         allowed_languages: ["typescript", "python"],
 *         allowed_packages: ["lodash", "chalk"],
 *         max_file_size_bytes: 512_000,
 *       })],
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
  private readonly config: SandboxConfig;

  constructor(config: SandboxConfig = {}) {
    this.config = config;
  }

  /**
   * Called once per runtime — creates the per-session sandbox directory
   * and builds the tool array.
   */
  async setup(context: VoiceContext): Promise<void> {
    this.sandbox = new SessionSandbox(context.session_id);
    await this.sandbox.init();

    this.tools = [
      createExecuteCodeTool({
        defaults: {
          timeout_ms: this.config.timeout_ms,
          env: this.config.env,
        },
        sandbox: this.sandbox,
        allowed_languages: this.config.allowed_languages,
      }),
      createReadFileTool(this.sandbox),
      createWriteFileTool(this.sandbox, this.config.max_file_size_bytes),
      createInstallPackageTool(this.sandbox, {
        allowedPackages: this.config.allowed_packages,
        timeout_ms: this.config.install_timeout_ms,
      }),
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
