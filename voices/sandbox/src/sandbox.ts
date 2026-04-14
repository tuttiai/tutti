/**
 * Per-session filesystem sandbox.
 *
 * Creates a unique temp directory for each session and enforces that
 * all file operations stay within it.
 */

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_ROOT = join(tmpdir(), "tutti-sandbox");

/**
 * Thrown when a path resolves outside the sandbox directory.
 */
export class SandboxEscapeError extends Error {
  readonly code = "SANDBOX_ESCAPE";

  constructor(requested: string) {
    super(
      "Path escapes the sandbox: the resolved path is outside the " +
        "session directory. Use a relative path or one that stays " +
        "within the sandbox root.",
    );
    this.name = "SandboxEscapeError";
    // Don't store the actual resolved path — that would leak the host
    // temp dir. Store only the user-provided input.
    (this as Record<string, unknown>).requested = requested;
  }
}

/**
 * Manages the lifecycle of a per-session sandbox directory.
 *
 * Usage:
 *   const sb = new SessionSandbox("session-123");
 *   await sb.init();           // creates the directory
 *   const safe = sb.resolve("file.txt");  // returns absolute path inside sandbox
 *   sb.resolve("../../etc/passwd");       // throws SandboxEscapeError
 *   await sb.destroy();        // removes the directory tree
 */
export class SessionSandbox {
  /** Absolute path to this session's sandbox directory. */
  readonly root: string;
  private initialized = false;

  constructor(sessionId: string) {
    // Session IDs may contain characters unsafe for paths. Sanitise to
    // alphanumeric + hyphens.
    const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "_");
    this.root = join(SANDBOX_ROOT, safe);
  }

  /** Create the sandbox directory. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true });
    this.initialized = true;
  }

  /**
   * Resolve a user-provided path to an absolute path inside the
   * sandbox. Throws {@link SandboxEscapeError} if the resolved path
   * escapes the sandbox root.
   *
   * @param userPath - Relative or absolute path from the agent.
   * @returns Absolute path guaranteed to be under {@link root}.
   */
  resolve(userPath: string): string {
    // Resolve against the sandbox root so relative paths work.
    const resolved = resolve(this.root, userPath);

    // The trailing separator ensures "/tmp/tutti-sandbox/abc" doesn't
    // match "/tmp/tutti-sandbox/abcdef".
    const prefix = this.root.endsWith("/") ? this.root : this.root + "/";

    if (resolved !== this.root && !resolved.startsWith(prefix)) {
      throw new SandboxEscapeError(userPath);
    }

    return resolved;
  }

  /** Remove the entire sandbox directory tree. */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    this.initialized = false;
  }
}
